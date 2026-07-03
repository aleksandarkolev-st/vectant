#!/usr/bin/env node
// Generic source-first visual GPU-HMR proof launcher.
//
// This file selects runner inputs only. It does not authorize GPU-HMR success:
// acceptance still comes from the source-first runner, strict runtime ledger,
// epoch/dispatch proof, output oracle bytes, and validation-matrix recompute.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readOption(args, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === name) return args[index + 1] ?? '';
    if (typeof value === 'string' && value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return '';
}

function hasFlag(args, name) {
  return args.includes(name);
}

function setDefaultEnv(name, value) {
  if (process.env[name] == null || process.env[name] === '') {
    process.env[name] = value;
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function contentHashForText(value) {
  return `sha256:${sha256Hex(String(value ?? ''))}`;
}

function contentHashForObject(value) {
  return `sha256:${sha256Hex(stableJson(value))}`;
}

function cleanRel(value) {
  const text = String(value ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  const normalized = path.posix.normalize(text);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`invalid source path ${value}`);
  }
  return normalized;
}

function numericEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SOURCE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cl',
  '.comp',
  '.cpp',
  '.cu',
  '.cuh',
  '.cxx',
  '.frag',
  '.glsl',
  '.h',
  '.hh',
  '.hip',
  '.hpp',
  '.hlsl',
  '.hxx',
  '.inc',
  '.inl',
  '.metal',
  '.rs',
  '.slang',
  '.vert',
  '.wgsl',
]);

const ENTRY_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cl',
  '.comp',
  '.cpp',
  '.cu',
  '.cxx',
  '.frag',
  '.glsl',
  '.hip',
  '.hlsl',
  '.metal',
  '.rs',
  '.slang',
  '.vert',
  '.wgsl',
]);

const IGNORED_SOURCE_DIRS = new Set([
  '.cache',
  '.git',
  '.gpu-hmr-test-logs',
  '.synthi',
  '.svn',
  'bazel-bin',
  'bazel-out',
  'bazel-testlogs',
  'build',
  'cmake-build-debug',
  'cmake-build-release',
  'dist',
  'node_modules',
  'out',
  'target',
  'third_party',
  'vendor',
]);

const ENTRY_PRIORITY = [
  'src/main.cpp',
  'main.cpp',
  'src/main.cc',
  'main.cc',
  'src/main.cxx',
  'main.cxx',
  'src/main.hip',
  'main.hip',
  'src/main.cu',
  'main.cu',
  'src/main.cl',
  'main.cl',
  'src/main.wgsl',
  'main.wgsl',
  'src/lib.rs',
  'lib.rs',
];

function assertInsideRoot(filePath, rootPath) {
  const rootReal = realpathSync(rootPath);
  const fileReal = realpathSync(filePath);
  const rel = path.relative(rootReal, fileReal);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return;
  throw new Error(`source root scan escaped root: ${filePath}`);
}

function sourceFilesForRoot(sourceRoot) {
  const root = realpathSync(path.resolve(sourceRoot));
  const maxFiles = numericEnv('SYNTHI_GPU_AGENT_SOURCE_ROOT_MAX_FILES', 512);
  const maxTotalBytes = numericEnv('SYNTHI_GPU_AGENT_SOURCE_ROOT_MAX_TOTAL_BYTES', 12 * 1024 * 1024);
  const maxFileBytes = numericEnv('SYNTHI_GPU_AGENT_SOURCE_ROOT_MAX_FILE_BYTES', 2 * 1024 * 1024);
  const files = [];
  let totalBytes = 0;
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_SOURCE_DIRS.has(entry.name)) walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) continue;
      assertInsideRoot(fullPath, root);
      const stat = statSync(fullPath);
      if (stat.size > maxFileBytes) {
        throw new Error(
          `source file ${fullPath} exceeds ${maxFileBytes} bytes; provide --source-manifest with the intended source set`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > maxTotalBytes) {
        throw new Error(
          `source root ${root} exceeds ${maxTotalBytes} bytes of source input; provide --source-manifest with the intended source set`,
        );
      }
      if (files.length >= maxFiles) {
        throw new Error(
          `source root ${root} has more than ${maxFiles} source files; provide --source-manifest with the intended source set`,
        );
      }
      const relativePath = cleanRel(path.relative(root, fullPath));
      const content = readFileSync(fullPath, 'utf8');
      files.push({
        path: relativePath,
        sourcePath: relativePath,
        source_path: relativePath,
        contentHash: contentHashForText(content),
        content_hash: contentHashForText(content),
        byteLength: Buffer.byteLength(content, 'utf8'),
        byte_length: Buffer.byteLength(content, 'utf8'),
      });
    }
  };
  walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function inferEntryPath(files, requestedEntry) {
  if (requestedEntry) {
    const entryPath = cleanRel(requestedEntry);
    if (!files.some((file) => file.path === entryPath)) {
      throw new Error(`--source-entry ${entryPath} is not present in the scanned source root`);
    }
    return entryPath;
  }
  const byPriority = ENTRY_PRIORITY.find((entryPath) =>
    files.some((file) => file.path === entryPath)
  );
  if (byPriority) return byPriority;
  const mainCandidates = files.filter((file) => {
    const base = path.posix.basename(file.path).toLowerCase();
    return /^main\.(c|cc|cl|comp|cpp|cu|cxx|frag|glsl|hip|hlsl|metal|rs|slang|vert|wgsl)$/.test(base);
  });
  if (mainCandidates.length === 1) return mainCandidates[0].path;
  if (mainCandidates.length > 1) {
    throw new Error(
      `source root has multiple main entry candidates (${mainCandidates.map((file) => file.path).join(', ')}); provide --source-entry or --source-manifest`,
    );
  }
  const entryCandidates = files.filter((file) => ENTRY_EXTENSIONS.has(path.extname(file.path).toLowerCase()));
  if (entryCandidates.length === 1) return entryCandidates[0].path;
  throw new Error('source root entry is ambiguous; provide --source-entry or --source-manifest');
}

function synthesizeSourceManifestFromRoot({
  sourceRoot,
  sourceEntry,
  sourceAuthority,
}) {
  if (!sourceRoot) throw new Error('source root is required');
  const root = realpathSync(path.resolve(sourceRoot));
  if (!existsSync(root)) throw new Error(`source root not found: ${root}`);
  const files = sourceFilesForRoot(root);
  if (files.length === 0) {
    throw new Error(`source root ${root} contains no supported source files`);
  }
  const entryPath = inferEntryPath(files, sourceEntry);
  const fileManifest = files.map((file) => ({
    path: file.path,
    contentHash: file.contentHash,
    content_hash: file.contentHash,
    byteLength: file.byteLength,
    byte_length: file.byteLength,
  }));
  const manifestHash = contentHashForObject(fileManifest);
  const manifest = {
    schemaVersion: 'synthi.gpu_hmr.agent_split_direct_source_manifest.v1',
    schema_version: 'synthi.gpu_hmr.agent_split_direct_source_manifest.v1',
    proofAuthority: 'source_root_scan_manifest_only_not_gpu_hmr_success',
    proof_authority: 'source_root_scan_manifest_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    sourceAuthority: sourceAuthority || 'direct_local_git_repo_path',
    source_authority: sourceAuthority || 'direct_local_git_repo_path',
    sourceRoot: root,
    source_root: root,
    entryPath,
    entry_path: entryPath,
    manifestHash,
    manifest_hash: manifestHash,
    fileManifest,
    file_manifest: fileManifest,
    files,
    source: {
      sourceAuthority: sourceAuthority || 'direct_local_git_repo_path',
      source_authority: sourceAuthority || 'direct_local_git_repo_path',
      sourceRoot: root,
      source_root: root,
      entryPath,
      entry_path: entryPath,
      files,
    },
  };
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outputDir = path.resolve(scriptDir, '..', '.gpu-hmr-test-logs', 'direct-source-manifests', 'generated');
  mkdirSync(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, `source-root-${manifestHash.slice('sha256:'.length, 'sha256:'.length + 16)}.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    manifest,
    manifestPath,
  };
}

function selfCheckSourceRootManifest() {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'synthi-source-root-manifest-'));
  mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  writeFileSync(path.join(tmpRoot, 'src', 'main.cpp'), '#include "scene_config.h"\nint main(){return 0;}\n');
  writeFileSync(path.join(tmpRoot, 'src', 'scene_config.h'), '#pragma once\nconstexpr int kPixels = 16;\n');
  const generated = synthesizeSourceManifestFromRoot({
    sourceRoot: tmpRoot,
    sourceEntry: 'src/main.cpp',
    sourceAuthority: 'user_source_files',
  });
  if (!existsSync(generated.manifestPath)) {
    throw new Error('source-root manifest self-check failed: manifest not written');
  }
  if (generated.manifest.entryPath !== 'src/main.cpp') {
    throw new Error('source-root manifest self-check failed: entry not preserved');
  }
  if (generated.manifest.files.length !== 2) {
    throw new Error('source-root manifest self-check failed: source file count mismatch');
  }
  if (generated.manifest.acceptedForGpuHmr !== false || generated.manifest.gpuHmrSuccess !== false) {
    throw new Error('source-root manifest self-check failed: manifest claimed GPU HMR authority');
  }
  console.log(`source-root manifest self-check passed: ${generated.manifestPath}`);
}

const args = process.argv.slice(2);
const selfCheck = hasFlag(args, '--self-check');
const prepareSourceManifestOnly = hasFlag(args, '--prepare-source-manifest-only');
const fixture = readOption(args, '--fixture') || process.env.SYNTHI_GPU_AGENT_FIXTURE || '';
const profile = readOption(args, '--profile') || process.env.SYNTHI_GPU_AGENT_PROFILE_PATH || '';
let sourceManifest =
  readOption(args, '--source-manifest')
  || process.env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH
  || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH
  || '';
const sourceRoot =
  readOption(args, '--source-root')
  || process.env.SYNTHI_GPU_AGENT_SOURCE_ROOT
  || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT
  || '';
const sourceEntry =
  readOption(args, '--source-entry')
  || process.env.SYNTHI_GPU_AGENT_SOURCE_ENTRY_PATH
  || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ENTRY_PATH
  || '';
const sourceAuthority =
  readOption(args, '--source-authority')
  || process.env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY
  || process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY
  || '';
const vendor = readOption(args, '--vendor') || process.env.SYNTHI_GPU_VENDOR || 'rocm';

if (fixture && profile) {
  throw new Error('choose either --fixture or --profile, not both');
}

if (selfCheck) {
  selfCheckSourceRootManifest();
}

if (!fixture && !profile && !sourceManifest && !sourceRoot && !selfCheck) {
  throw new Error('source-first visual proof requires --fixture, --profile, --source-manifest, or --source-root');
}

let generatedSourceManifest = null;
if (!sourceManifest && sourceRoot) {
  generatedSourceManifest = synthesizeSourceManifestFromRoot({
    sourceRoot,
    sourceEntry,
    sourceAuthority,
  });
  sourceManifest = generatedSourceManifest.manifestPath;
  console.log(`source-root direct source manifest: ${sourceManifest}`);
}

if (prepareSourceManifestOnly) {
  console.log(JSON.stringify({
    manifestPath: sourceManifest || null,
    manifest: generatedSourceManifest?.manifest ?? null,
  }, null, 2));
  process.exit(0);
}

if (fixture) process.env.SYNTHI_GPU_AGENT_FIXTURE = fixture;
if (profile) process.env.SYNTHI_GPU_AGENT_PROFILE_PATH = profile;
if (sourceManifest) {
  process.env.SYNTHI_GPU_AGENT_SOURCE_MANIFEST_PATH = sourceManifest;
  process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_MANIFEST_PATH = sourceManifest;
}
if (sourceRoot) {
  process.env.SYNTHI_GPU_AGENT_SOURCE_ROOT = sourceRoot;
  process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ROOT = sourceRoot;
}
if (sourceEntry) {
  process.env.SYNTHI_GPU_AGENT_SOURCE_ENTRY_PATH = sourceEntry;
  process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_ENTRY_PATH = sourceEntry;
}
if (sourceAuthority) {
  process.env.SYNTHI_GPU_AGENT_SOURCE_AUTHORITY = sourceAuthority;
  process.env.SYNTHI_GPU_AGENT_DIRECT_SOURCE_AUTHORITY = sourceAuthority;
}

setDefaultEnv('SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS', '1');
setDefaultEnv('SYNTHI_SYNC_TO_GCS', '0');
setDefaultEnv('SYNTHI_VALIDATION_AUTHLESS_WORKSPACE', '1');
setDefaultEnv('SYNTHI_GPU_HMR_STRICT_PROOF_RETRY_TIMEOUT_MS', '240000');
setDefaultEnv('SYNTHI_GPU_VENDOR', vendor);

await import('./gpu-hmr-agent-split-workspace-test.mjs');
