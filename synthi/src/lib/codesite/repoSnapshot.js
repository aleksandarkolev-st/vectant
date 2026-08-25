import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getCodeSiteRuntimeConfig } from './runtimeConfig';
import { asArray, stableJson } from './json';
import { detectRepoRoot } from './repoPolicyCompiler';
import { digest, matchPathPattern, normalizePath, normalizePathList } from './policy';

export const READ_SNAPSHOT_SCHEMA_VERSION = 'synthi.codesite.readSnapshotEvidence.v1';

const DEFAULT_MAX_FILES = 512;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SCAN_ENTRIES = 15000;
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.synthi',
  'coverage',
  'dist',
  'build',
  'node_modules',
]);

export async function buildReadSnapshotEvidence(readSet, options = {}) {
  const normalizedReadSet = normalizePathList(readSet);
  const limits = normalizeLimits(options);
  const repoRoot = resolveCodeSiteRepoRoot(options);
  const scope = normalizeSnapshotScope(options.scope || options.snapshotScope || options.snapshot_scope);
  const repoManifestExcludedPaths = scope === 'repo_wide'
    ? normalizePathList(options.excludePaths || options.exclude_paths || options.repoManifestExcludedPaths || options.repo_manifest_excluded_paths || [])
    : [];
  const generatedAt = new Date().toISOString();
  const baseEvidence = {
    schemaVersion: READ_SNAPSHOT_SCHEMA_VERSION,
    status: normalizedReadSet.length ? 'recording' : 'empty',
    scope,
    readSet: normalizedReadSet,
    repoRoot,
    fileDigests: [],
    missingPaths: [],
    skippedPaths: [],
    truncated: false,
    repoManifestDigest: null,
    repoManifestFileCount: 0,
    repoManifestScannedEntries: 0,
    repoManifestTruncated: false,
    repoManifestSkippedPaths: [],
    repoManifestExcludedPaths,
    limits,
    generatedAt,
    source: options.source || 'codesite_control_plane',
  };

  if (!normalizedReadSet.length && scope !== 'repo_wide') {
    return finalizeEvidence({ ...baseEvidence, status: 'empty' });
  }

  if (!repoRoot) {
    return finalizeEvidence({
      ...baseEvidence,
      status: 'unavailable',
      unavailableReason: 'repo_root_not_configured',
    });
  }

  try {
    await fs.access(repoRoot);
  } catch (error) {
    return finalizeEvidence({
      ...baseEvidence,
      status: 'unavailable',
      unavailableReason: 'repo_root_not_accessible',
      error: error?.message || String(error),
    });
  }

  const accumulator = {
    files: new Set(),
    missingPaths: new Set(),
    skippedPaths: [],
    truncated: false,
    scanEntries: 0,
  };

  if (normalizedReadSet.length) {
    for (const entry of normalizedReadSet) {
      if (accumulator.files.size >= limits.maxFiles) {
        accumulator.truncated = true;
        accumulator.skippedPaths.push({ path: entry, reason: 'max_files_exceeded' });
        continue;
      }
      await collectReadSetEntry(repoRoot, entry, accumulator, limits);
    }
  }

  const fileDigests = [];
  for (const filePath of [...accumulator.files].sort()) {
    const result = await digestRepoFile(repoRoot, filePath, limits);
    if (result.skipped) {
      accumulator.skippedPaths.push(result.skipped);
    } else {
      fileDigests.push(result.file);
    }
  }
  const repoManifest = scope === 'repo_wide'
    ? await buildRepoManifest(repoRoot, limits, repoManifestExcludedPaths)
    : emptyRepoManifest();

  return finalizeEvidence({
    ...baseEvidence,
    status: 'recorded',
    fileDigests,
    missingPaths: [...accumulator.missingPaths].sort(),
    skippedPaths: accumulator.skippedPaths.sort(comparePathEntries),
    truncated: accumulator.truncated,
    scannedEntries: accumulator.scanEntries,
    repoManifestDigest: repoManifest.repoManifestDigest,
    repoManifestFileCount: repoManifest.repoManifestFileCount,
    repoManifestScannedEntries: repoManifest.repoManifestScannedEntries,
    repoManifestTruncated: repoManifest.repoManifestTruncated,
    repoManifestSkippedPaths: repoManifest.repoManifestSkippedPaths,
    repoManifestExcludedPaths,
  });
}

export async function validateReadSnapshotEvidence(evidence, options = {}) {
  const expected = normalizeReadSnapshotEvidence(evidence);
  if (!expected) {
    return {
      ok: true,
      reasonCodes: ['repo_snapshot_not_recorded'],
      expected: null,
      current: null,
      driftedPaths: [],
    };
  }
  if (expected.status === 'empty') {
    return {
      ok: true,
      reasonCodes: ['repo_snapshot_empty_read_set'],
      expected,
      current: null,
      driftedPaths: [],
    };
  }
  if (expected.status !== 'recorded') {
    return {
      ok: false,
      reasonCodes: ['repo_snapshot_unavailable'],
      expected,
      current: null,
      driftedPaths: [],
    };
  }

  const current = await buildReadSnapshotEvidence(expected.readSet, {
    ...options,
    repoRoot: options.repoRoot || options.root || expected.repoRoot,
    scope: expected.scope,
    excludePaths: options.excludePaths || options.exclude_paths || expected.repoManifestExcludedPaths,
    maxFiles: expected.limits?.maxFiles,
    maxFileBytes: expected.limits?.maxFileBytes,
    maxScanEntries: expected.limits?.maxScanEntries,
    source: 'codesite_validation',
  });
  if (current.status !== 'recorded') {
    return {
      ok: false,
      reasonCodes: ['repo_snapshot_unavailable'],
      expected,
      current,
      driftedPaths: [],
    };
  }

  const driftedPaths = compareSnapshotFiles(expected, current);
  const digestChanged = expected.snapshotDigest !== current.snapshotDigest;
  const repoManifestDrifted = expected.scope === 'repo_wide'
    && expected.repoManifestDigest !== current.repoManifestDigest;
  const ok = !digestChanged && driftedPaths.length === 0;
  return {
    ok,
    reasonCodes: ok ? ['repo_snapshot_stable'] : [
      'repo_snapshot_drift_detected',
      ...(repoManifestDrifted ? ['repo_snapshot_repo_manifest_drift_detected'] : []),
    ],
    expected,
    current,
    driftedPaths,
    digestChanged,
    repoManifestDrifted,
  };
}

export function normalizeReadSnapshotEvidence(input) {
  if (!input || typeof input !== 'object') return null;
  const readSet = normalizePathList(input.readSet || input.read_set || []);
  const fileDigests = normalizeSnapshotFiles(input.fileDigests || input.file_digests || input.files);
  const evidence = {
    schemaVersion: input.schemaVersion || input.schema_version || READ_SNAPSHOT_SCHEMA_VERSION,
    status: input.status || (readSet.length ? 'recorded' : 'empty'),
    scope: normalizeSnapshotScope(input.scope || input.snapshotScope || input.snapshot_scope),
    readSet,
    repoRoot: input.repoRoot || input.repo_root || null,
    fileDigests,
    missingPaths: normalizePathList(input.missingPaths || input.missing_paths || []),
    skippedPaths: normalizeSkippedPaths(input.skippedPaths || input.skipped_paths || []),
    truncated: Boolean(input.truncated),
    repoManifestDigest: input.repoManifestDigest || input.repo_manifest_digest || null,
    repoManifestFileCount: Number.isFinite(input.repoManifestFileCount) ? input.repoManifestFileCount : Number(input.repo_manifest_file_count || 0),
    repoManifestScannedEntries: Number.isFinite(input.repoManifestScannedEntries) ? input.repoManifestScannedEntries : Number(input.repo_manifest_scanned_entries || 0),
    repoManifestTruncated: Boolean(input.repoManifestTruncated || input.repo_manifest_truncated),
    repoManifestSkippedPaths: normalizeSkippedPaths(input.repoManifestSkippedPaths || input.repo_manifest_skipped_paths || []),
    repoManifestExcludedPaths: normalizePathList(input.repoManifestExcludedPaths || input.repo_manifest_excluded_paths || []),
    limits: normalizeLimits(input.limits || input),
    generatedAt: input.generatedAt || input.generated_at || null,
    source: input.source || 'codesite_control_plane',
  };
  evidence.snapshotDigest = input.snapshotDigest || input.snapshot_digest || buildSnapshotDigest(evidence);
  evidence.evidenceDigest = input.evidenceDigest || input.evidence_digest || digest({
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    scope: evidence.scope,
    readSet: evidence.readSet,
    snapshotDigest: evidence.snapshotDigest,
    fileCount: evidence.fileDigests.length,
    missingPaths: evidence.missingPaths,
    skippedPaths: evidence.skippedPaths,
    truncated: evidence.truncated,
    repoManifestDigest: evidence.repoManifestDigest,
    repoManifestFileCount: evidence.repoManifestFileCount,
    repoManifestTruncated: evidence.repoManifestTruncated,
    repoManifestSkippedPaths: evidence.repoManifestSkippedPaths,
    repoManifestExcludedPaths: evidence.repoManifestExcludedPaths,
    source: evidence.source,
  });
  return evidence;
}

export function resolveCodeSiteRepoRoot(options = {}) {
  const configured = options.repoRoot || options.root || process.env.SYNTHI_CODESITE_REPO_ROOT;
  if (configured) return path.resolve(configured);
  return detectRepoRoot(process.cwd());
}

async function collectReadSetEntry(repoRoot, readPath, accumulator, limits) {
  if (hasGlob(readPath)) {
    await collectGlobMatches(repoRoot, readPath, accumulator, limits);
    return;
  }

  const target = resolveInsideRepo(repoRoot, readPath);
  if (!target) {
    accumulator.skippedPaths.push({ path: readPath, reason: 'path_escape' });
    return;
  }

  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') accumulator.missingPaths.add(readPath);
    else accumulator.skippedPaths.push({ path: readPath, reason: 'stat_failed', error: error?.message || String(error) });
    return;
  }

  if (stat.isSymbolicLink()) {
    accumulator.skippedPaths.push({ path: readPath, reason: 'symlink_skipped' });
    return;
  }
  if (stat.isDirectory()) {
    await collectDirectory(repoRoot, readPath, accumulator, limits);
    return;
  }
  if (stat.isFile()) {
    addFile(accumulator, readPath, limits);
  }
}

async function collectGlobMatches(repoRoot, pattern, accumulator, limits) {
  const before = accumulator.files.size;
  await collectDirectory(repoRoot, '', accumulator, limits, (filePath) => matchPathPattern(filePath, pattern));
  if (accumulator.files.size === before) accumulator.missingPaths.add(pattern);
}

async function collectDirectory(repoRoot, relDir, accumulator, limits, predicate = () => true) {
  if (accumulator.files.size >= limits.maxFiles || accumulator.scanEntries >= limits.maxScanEntries) {
    accumulator.truncated = true;
    return;
  }

  const absoluteDir = resolveInsideRepo(repoRoot, relDir || '');
  if (!absoluteDir) {
    accumulator.skippedPaths.push({ path: relDir, reason: 'path_escape' });
    return;
  }

  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    accumulator.skippedPaths.push({ path: relDir || '.', reason: 'read_dir_failed', error: error?.message || String(error) });
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (accumulator.files.size >= limits.maxFiles || accumulator.scanEntries >= limits.maxScanEntries) {
      accumulator.truncated = true;
      return;
    }

    const rel = normalizePath(path.posix.join(relDir || '', entry.name));
    if (!rel) continue;
    accumulator.scanEntries += 1;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await collectDirectory(repoRoot, rel, accumulator, limits, predicate);
    } else if (entry.isFile() && predicate(rel)) {
      addFile(accumulator, rel, limits);
    } else if (entry.isSymbolicLink() && predicate(rel)) {
      accumulator.skippedPaths.push({ path: rel, reason: 'symlink_skipped' });
    }
  }
}

async function buildRepoManifest(repoRoot, limits, excludedPaths = []) {
  const accumulator = {
    files: new Set(),
    missingPaths: new Set(),
    skippedPaths: [],
    truncated: false,
    scanEntries: 0,
    excludedPaths,
  };
  await collectDirectory(repoRoot, '', accumulator, limits, () => true);
  const fileDigests = [];
  for (const filePath of [...accumulator.files].sort()) {
    const result = await digestRepoFile(repoRoot, filePath, limits);
    if (result.skipped) accumulator.skippedPaths.push(result.skipped);
    else fileDigests.push(result.file);
  }
  return {
    repoManifestDigest: digest({
      schemaVersion: READ_SNAPSHOT_SCHEMA_VERSION,
      scope: 'repo_wide',
      fileDigests,
      skippedPaths: accumulator.skippedPaths.sort(comparePathEntries),
      truncated: accumulator.truncated,
      limits,
    }),
    repoManifestFileCount: fileDigests.length,
    repoManifestScannedEntries: accumulator.scanEntries,
    repoManifestTruncated: accumulator.truncated,
    repoManifestSkippedPaths: accumulator.skippedPaths.sort(comparePathEntries),
  };
}

function emptyRepoManifest() {
  return {
    repoManifestDigest: null,
    repoManifestFileCount: 0,
    repoManifestScannedEntries: 0,
    repoManifestTruncated: false,
    repoManifestSkippedPaths: [],
    repoManifestExcludedPaths: [],
  };
}

function addFile(accumulator, filePath, limits) {
  if (isRepoManifestExcluded(filePath, accumulator.excludedPaths || [])) {
    return;
  }
  if (accumulator.files.size >= limits.maxFiles) {
    accumulator.truncated = true;
    accumulator.skippedPaths.push({ path: filePath, reason: 'max_files_exceeded' });
    return;
  }
  accumulator.files.add(filePath);
}

async function digestRepoFile(repoRoot, filePath, limits) {
  const absolutePath = resolveInsideRepo(repoRoot, filePath);
  if (!absolutePath) return { skipped: { path: filePath, reason: 'path_escape' } };
  let stat;
  try {
    stat = await fs.stat(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { file: { path: filePath, exists: false, size: null, digest: null } };
    }
    return { skipped: { path: filePath, reason: 'stat_failed', error: error?.message || String(error) } };
  }
  if (!stat.isFile()) return { skipped: { path: filePath, reason: 'not_a_file' } };
  if (stat.size > limits.maxFileBytes) {
    return { skipped: { path: filePath, reason: 'file_too_large', size: stat.size } };
  }
  const content = await fs.readFile(absolutePath);
  return {
    file: {
      path: filePath,
      exists: true,
      size: stat.size,
      digest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    },
  };
}

function finalizeEvidence(evidence) {
  const normalized = normalizeReadSnapshotEvidence(evidence);
  normalized.snapshotDigest = buildSnapshotDigest(normalized);
  normalized.evidenceDigest = digest({
    schemaVersion: normalized.schemaVersion,
    status: normalized.status,
    scope: normalized.scope,
    readSet: normalized.readSet,
    snapshotDigest: normalized.snapshotDigest,
    fileCount: normalized.fileDigests.length,
    missingPaths: normalized.missingPaths,
    skippedPaths: normalized.skippedPaths,
    truncated: normalized.truncated,
    repoManifestDigest: normalized.repoManifestDigest,
    repoManifestFileCount: normalized.repoManifestFileCount,
    repoManifestTruncated: normalized.repoManifestTruncated,
    repoManifestSkippedPaths: normalized.repoManifestSkippedPaths,
    repoManifestExcludedPaths: normalized.repoManifestExcludedPaths,
    source: normalized.source,
  });
  return normalized;
}

function buildSnapshotDigest(evidence) {
  return digest({
    schemaVersion: evidence.schemaVersion,
    status: evidence.status,
    scope: evidence.scope,
    readSet: evidence.readSet,
    fileDigests: evidence.fileDigests,
    missingPaths: evidence.missingPaths,
    skippedPaths: evidence.skippedPaths.map(({ path: skippedPath, reason, size }) => ({ path: skippedPath, reason, size: size ?? null })),
    truncated: evidence.truncated,
    repoManifestDigest: evidence.repoManifestDigest,
    repoManifestFileCount: evidence.repoManifestFileCount,
    repoManifestTruncated: evidence.repoManifestTruncated,
    repoManifestSkippedPaths: evidence.repoManifestSkippedPaths.map(({ path: skippedPath, reason, size }) => ({ path: skippedPath, reason, size: size ?? null })),
    limits: evidence.limits,
  });
}

function isRepoManifestExcluded(filePath, excludedPaths = []) {
  return normalizePathList(excludedPaths).some((pattern) => (
    pattern === filePath
      || matchPathPattern(filePath, pattern)
      || (pattern.endsWith('/**') && filePath.startsWith(pattern.slice(0, -3)))
  ));
}

function compareSnapshotFiles(expected, current) {
  const expectedMap = new Map(expected.fileDigests.map((file) => [file.path, file]));
  const currentMap = new Map(current.fileDigests.map((file) => [file.path, file]));
  const paths = new Set([...expectedMap.keys(), ...currentMap.keys(), ...expected.missingPaths, ...current.missingPaths]);
  const drifted = [];

  for (const filePath of [...paths].sort()) {
    const before = expectedMap.get(filePath) || missingFile(filePath);
    const after = currentMap.get(filePath) || missingFile(filePath);
    if (before.exists !== after.exists || before.digest !== after.digest || before.size !== after.size) {
      drifted.push({ path: filePath, before, after });
    }
  }

  if (expected.snapshotDigest !== current.snapshotDigest && drifted.length === 0) {
    drifted.push({
      path: '*',
      before: { snapshotDigest: expected.snapshotDigest },
      after: { snapshotDigest: current.snapshotDigest },
    });
  }

  return drifted;
}

function normalizeSnapshotScope(value) {
  return String(value || '').trim().toLowerCase() === 'repo_wide' ? 'repo_wide' : 'read_set';
}

function missingFile(filePath) {
  return { path: filePath, exists: false, size: null, digest: null };
}

function normalizeSnapshotFiles(files) {
  return asArray(files)
    .map((file) => ({
      path: normalizePath(file?.path || file?.filePath || file?.file_path),
      exists: file?.exists !== false,
      size: Number.isFinite(file?.size) ? file.size : null,
      digest: file?.digest || file?.contentDigest || file?.content_digest || null,
    }))
    .filter((file) => file.path)
    .sort(comparePathEntries);
}

function normalizeSkippedPaths(paths) {
  return asArray(paths)
    .map((entry) => {
      if (typeof entry === 'string') return { path: normalizePath(entry), reason: 'skipped' };
      return {
        path: normalizePath(entry?.path || entry?.filePath || entry?.file_path),
        reason: entry?.reason || 'skipped',
        size: Number.isFinite(entry?.size) ? entry.size : undefined,
        error: entry?.error || undefined,
      };
    })
    .filter((entry) => entry.path)
    .sort(comparePathEntries);
}

function normalizeLimits(options = {}) {
  const config = getCodeSiteRuntimeConfig();
  return {
    maxFiles: positiveInt(options.maxFiles || options.max_files, config.snapshotMaxFiles),
    maxFileBytes: positiveInt(
      options.maxFileBytes || options.max_file_bytes,
      config.snapshotMaxFileBytes,
    ),
    maxScanEntries: positiveInt(
      options.maxScanEntries || options.max_scan_entries,
      config.snapshotMaxScanEntries,
    ),
  };
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function resolveInsideRepo(repoRoot, relPath) {
  if (!relPath || relPath === '.') return path.resolve(repoRoot);
  const normalized = normalizePath(relPath || '.');
  if (!normalized) return null;
  const target = normalized === '.' ? path.resolve(repoRoot) : path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, target);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) return null;
  return target;
}

function hasGlob(value) {
  return String(value || '').includes('*');
}

function comparePathEntries(a, b) {
  return String(a.path || '').localeCompare(String(b.path || ''));
}
