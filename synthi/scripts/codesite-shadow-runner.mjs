#!/usr/bin/env node
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_COPY_EXCLUDES = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'tmp',
]);

const DEFAULT_ALLOWED_BINARIES = [
  'git',
  'node',
  'npm',
  'npx',
  'pnpm',
  'tsc',
  'vitest',
  'yarn',
  process.execPath,
];

const SAFE_ENV_KEYS = [
  'CI',
  'HOME',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'NODE_PATH',
  'PATH',
  'PLAYWRIGHT_BROWSERS_PATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
];

const MAX_UNIFIED_PATCH_ARTIFACTS = 64;
const MAX_UNIFIED_PATCH_BYTES = 5 * 1024 * 1024;
const MAX_UNIFIED_PATCH_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_GIT_CAPTURE_CHARS = 256 * 1024;
// Workstream E: cap on validation commands executed per git-patch plan.
const MAX_PATCH_MODE_COMMANDS = 32;

const SECRET_PATTERNS = [
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'bearer_token', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { name: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function digestBytes(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'utf8');
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function tail(value, limit = 6000) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}

function redact(value) {
  let text = String(value || '');
  const counts = {};
  for (const { name, pattern } of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      counts[name] = (counts[name] || 0) + 1;
      return `[REDACTED:${name}]`;
    });
  }
  return { text, counts };
}

function mergeCounts(...items) {
  const merged = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item || {})) {
      merged[key] = (merged[key] || 0) + value;
    }
  }
  return merged;
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const input = fsSync.readFileSync(0, 'utf8');
  return input ? JSON.parse(input) : {};
}

function normalizeStrategy(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function workspaceRoot() {
  const cwd = process.cwd();
  return path.basename(cwd) === 'synthi' ? path.dirname(cwd) : cwd;
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function allowedRoot() {
  return path.resolve(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_ROOT || workspaceRoot());
}

function resolveInside(root, candidate, label) {
  const resolved = path.resolve(root, candidate || '.');
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`${label}_outside_allowed_root`);
  }
  return resolved;
}

function resolveInsideWorktree(root, candidate, label) {
  const resolved = path.resolve(root, candidate || '.');
  const relative = path.relative(root, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`${label}_outside_worktree`);
  }
  return resolved;
}

function normalizeExecutionPlan(input) {
  const plan = input.shadowExecutionPlan
    || input.shadow_execution_plan
    || input.executionPlan
    || input.execution_plan
    || null;
  if (!plan || typeof plan !== 'object') return null;
  const repoRoot = plan.repoRoot || plan.repo_root || input.repoRoot || input.repo_root || null;
  const baseCommit = plan.baseCommit || plan.base_commit || plan.recordedBaseCommit || plan.recorded_base_commit || null;
  const patchArtifactInputs = asArray(plan.patchArtifacts || plan.patch_artifacts || plan.unifiedPatchArtifacts || plan.unified_patch_artifacts);
  const gitPatchModeRequested = Boolean(baseCommit || patchArtifactInputs.length);
  if (gitPatchModeRequested) {
    if (!repoRoot) throw new Error('shadow_git_repo_root_required');
    if (!baseCommit) throw new Error('shadow_git_base_commit_required');
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(String(baseCommit))) {
      throw new Error('shadow_git_base_commit_invalid');
    }
    if (!patchArtifactInputs.length) throw new Error('shadow_git_patch_artifacts_required');
    const commands = asArray(plan.commands || plan.checks || plan.inspections).map(normalizeCommand).filter(Boolean);
    // Workstream E: validation commands are allowed in git-patch mode only when
    // explicitly opted in via env — patches apply in a disposable worktree and
    // the impacted validation commands then run against that worktree copy.
    if (commands.length && !inlineRepoCommandsAllowed()) {
      throw new Error('shadow_git_patch_commands_not_supported');
    }
    if (commands.length > MAX_PATCH_MODE_COMMANDS) {
      throw new Error('shadow_patch_command_limit_exceeded');
    }
    if (patchArtifactInputs.length > MAX_UNIFIED_PATCH_ARTIFACTS) {
      throw new Error('shadow_patch_artifact_limit_exceeded');
    }
    const patchArtifacts = patchArtifactInputs.map(normalizeUnifiedPatchArtifact);
    if (patchArtifacts.reduce((sum, artifact) => sum + artifact.byteLength, 0) > MAX_UNIFIED_PATCH_TOTAL_BYTES) {
      throw new Error('shadow_patch_artifact_total_bytes_exceeded');
    }
    return {
      ...plan,
      mode: 'git_worktree_patch_execution',
      repoRoot,
      baseCommit: String(baseCommit).toLowerCase(),
      patchArtifacts,
      commands,
      timeoutMs: normalizeTimeout(plan.timeoutMs || plan.timeout_ms),
      keepWorktrees: false,
    };
  }

  const commands = asArray(plan.commands || plan.checks || plan.inspections).map(normalizeCommand).filter(Boolean);
  if (!repoRoot || commands.length === 0) return null;
  if (!inlineRepoCommandsAllowed()) return null;
  return {
    ...plan,
    mode: 'copy_command_execution',
    repoRoot,
    commands,
    timeoutMs: normalizeTimeout(plan.timeoutMs || plan.timeout_ms),
    keepWorktrees: Boolean(plan.keepWorktrees || plan.keep_worktrees || process.env.SYNTHI_CODESITE_SHADOW_RUNNER_KEEP_WORKTREES === '1'),
  };
}

function normalizeUnifiedPatchArtifact(value, index) {
  if (!value || typeof value !== 'object') throw new Error('shadow_patch_artifact_invalid');
  const content = value.content ?? value.patch ?? value.unifiedDiff ?? value.unified_diff;
  const contentBase64 = value.contentBase64 ?? value.content_base64;
  if (content == null && contentBase64 == null) throw new Error('shadow_patch_artifact_content_required');
  let bytes;
  if (contentBase64 != null) {
    const encoded = String(contentBase64);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('shadow_patch_artifact_base64_invalid');
    }
    bytes = Buffer.from(encoded, 'base64');
  } else {
    bytes = Buffer.from(String(content), 'utf8');
  }
  if (!bytes.length) throw new Error('shadow_patch_artifact_content_required');
  if (bytes.length > MAX_UNIFIED_PATCH_BYTES) throw new Error('shadow_patch_artifact_too_large');
  const claimedDigest = String(value.digest || value.contentDigest || value.content_digest || '').toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/.test(claimedDigest)) throw new Error('shadow_patch_artifact_digest_required');
  const computedDigest = digestBytes(bytes);
  return {
    id: String(value.id || value.artifactId || value.artifact_id || claimedDigest || `patch-${index + 1}`),
    digest: claimedDigest,
    computedDigest,
    bytes,
    byteLength: bytes.length,
    strategies: asArray(value.strategies || value.universes || value.strategy || value.universe)
      .map(normalizeStrategy)
      .filter(Boolean),
  };
}

function inlineRepoCommandsAllowed() {
  return ['1', 'true', 'yes'].includes(String(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_ALLOW_INLINE_COMMANDS || '').trim().toLowerCase());
}

function normalizeCommand(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    const [command, ...args] = value.map(String);
    return command ? { label: command, command, args } : null;
  }
  if (typeof value === 'string') {
    return { label: value, command: value, args: [] };
  }
  const command = value.command || value.executable || value.bin;
  if (!command) return null;
  return {
    label: String(value.label || value.name || command),
    command: String(command),
    args: asArray(value.args || value.argv).map(String),
    cwd: value.cwd || value.workingDirectory || value.working_directory || null,
    timeoutMs: normalizeTimeout(value.timeoutMs || value.timeout_ms),
  };
}

function normalizeTimeout(value) {
  const max = Number(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_MAX_COMMAND_TIMEOUT_MS || 120000);
  const fallback = Number(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_COMMAND_TIMEOUT_MS || 30000);
  const requested = Number(value || fallback);
  const safeMax = Number.isFinite(max) && max > 0 ? max : 120000;
  return Math.min(Number.isFinite(requested) && requested > 0 ? requested : fallback, safeMax);
}

function allowedBinaries() {
  return new Set(asArray(parseJsonEnv('SYNTHI_CODESITE_SHADOW_RUNNER_ALLOWED_BINARIES_JSON', DEFAULT_ALLOWED_BINARIES)).map(String));
}

function commandIsAllowed(command, allowed) {
  const value = String(command || '');
  if (!value) return false;
  if (path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    return allowed.has(value) || allowed.has(path.resolve(value));
  }
  return allowed.has(value);
}

function commandEnvironment(worktreeRoot) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  const extraKeys = asArray(parseJsonEnv('SYNTHI_CODESITE_SHADOW_RUNNER_ENV_ALLOWLIST_JSON', []))
    .map(String)
    .filter(Boolean);
  for (const key of extraKeys) {
    if (process.env[key] != null && !/SECRET|TOKEN|KEY|PASSWORD|COOKIE|AUTH/i.test(key)) {
      env[key] = process.env[key];
    }
  }
  env.CI = env.CI || '1';
  env.SYNTHI_CODESITE_SHADOW_WORKTREE = worktreeRoot;
  return env;
}

function copyExcludes(plan) {
  return new Set([
    ...DEFAULT_COPY_EXCLUDES,
    ...asArray(plan.copyExcludes || plan.copy_excludes).map(String),
  ]);
}

async function copyRepository(sourceRoot, targetRoot, excludes) {
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    dereference: false,
    filter: async (source) => {
      if (excludes.has(path.basename(source))) return false;
      const stat = await fs.lstat(source);
      return !stat.isSymbolicLink();
    },
  });
}

function patchesForStrategy(plan, strategy) {
  const normalized = normalizeStrategy(strategy);
  const universes = plan.universes || plan.universePatches || plan.universe_patches || {};
  const direct = universes[strategy] || universes[normalized] || null;
  const strategyPatches = Array.isArray(direct) ? direct : asArray(direct?.patches || direct?.changes);
  const sharedPatches = asArray(plan.patches || plan.changes).filter((patch) => {
    const target = patch?.universe || patch?.strategy || patch?.universes || patch?.strategies;
    if (!target) return true;
    return asArray(target).map(normalizeStrategy).includes(normalized);
  });
  return [...sharedPatches, ...strategyPatches].filter(Boolean);
}

async function applyPatch(worktreeRoot, patch) {
  const relativePath = patch.path || patch.filePath || patch.file_path || patch.target;
  if (!relativePath) throw new Error('shadow_patch_missing_path');
  const filePath = resolveInsideWorktree(worktreeRoot, relativePath, 'shadow_patch_path');
  const action = patch.action || (patch.delete || patch.remove ? 'delete' : patch.append != null ? 'append' : patch.replace ? 'replace' : 'write');
  await assertNoSymlinkEscape(worktreeRoot, filePath, { includeTarget: action === 'delete' || action === 'remove' || action === 'append' || action === 'replace' });
  if (action === 'delete' || action === 'remove') {
    await fs.rm(filePath, { recursive: true, force: true });
    return { path: relativePath, action: 'delete' };
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await assertNoSymlinkEscape(worktreeRoot, filePath, { includeTarget: true });
  if (action === 'append') {
    await fs.appendFile(filePath, String(patch.append ?? patch.content ?? ''), 'utf8');
    return { path: relativePath, action: 'append', contentDigest: digest(patch.append ?? patch.content ?? '') };
  }
  if (action === 'replace') {
    const before = String(patch.replace?.from ?? patch.from ?? '');
    const after = String(patch.replace?.to ?? patch.to ?? '');
    const current = await fs.readFile(filePath, 'utf8');
    if (!before) throw new Error('shadow_patch_replace_missing_from');
    const next = current.replace(before, after);
    if (next === current) throw new Error('shadow_patch_replace_no_match');
    await fs.writeFile(filePath, next, 'utf8');
    return { path: relativePath, action: 'replace', contentDigest: digest(next) };
  }
  const content = patch.content != null
    ? String(patch.content)
    : stableJson(patch.json ?? patch.value ?? '');
  await fs.writeFile(filePath, content, 'utf8');
  return { path: relativePath, action: 'write', contentDigest: digest(content) };
}

async function assertNoSymlinkEscape(worktreeRoot, targetPath, { includeTarget = true } = {}) {
  const relative = path.relative(worktreeRoot, targetPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('shadow_patch_path_outside_worktree');
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let current = worktreeRoot;
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('shadow_patch_symlink_escape');
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
  }
}

function patchArtifactsForStrategy(plan, strategy) {
  const normalized = normalizeStrategy(strategy);
  const universes = plan.universes || plan.universePatches || plan.universe_patches || {};
  const direct = universes[strategy] || universes[normalized] || null;
  const refs = asArray(
    direct?.patchArtifactRefs
      || direct?.patch_artifact_refs
      || direct?.artifactRefs
      || direct?.artifact_refs,
  ).map(String).filter(Boolean);
  if (refs.length) {
    const byRef = new Map(plan.patchArtifacts.flatMap((artifact) => [
      [artifact.id, artifact],
      [artifact.digest, artifact],
    ]));
    return refs.map((ref) => {
      const artifact = byRef.get(ref);
      if (!artifact) throw new Error(`shadow_patch_artifact_ref_not_found:${ref}`);
      return artifact;
    });
  }
  return plan.patchArtifacts.filter((artifact) => (
    artifact.strategies.length === 0 || artifact.strategies.includes(normalized)
  ));
}

function gitEnvironment(worktreeRoot) {
  return {
    ...commandEnvironment(worktreeRoot),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

async function runGit(args, cwd, timeoutMs = normalizeTimeout()) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      env: gitEnvironment(cwd),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutTail = '';
    let stderrTail = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const stdoutHash = crypto.createHash('sha256');
    const stderrHash = crypto.createHash('sha256');
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutHash.update(chunk);
      const text = chunk.toString('utf8');
      stdoutTail = tail(`${stdoutTail}${text}`);
      if (stdout.length < MAX_GIT_CAPTURE_CHARS) {
        const next = `${stdout}${text}`;
        stdoutTruncated = stdoutTruncated || next.length > MAX_GIT_CAPTURE_CHARS;
        stdout = next.slice(0, MAX_GIT_CAPTURE_CHARS);
      } else {
        stdoutTruncated = true;
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrHash.update(chunk);
      const text = chunk.toString('utf8');
      stderrTail = tail(`${stderrTail}${text}`);
      if (stderr.length < MAX_GIT_CAPTURE_CHARS) {
        const next = `${stderr}${text}`;
        stderrTruncated = stderrTruncated || next.length > MAX_GIT_CAPTURE_CHARS;
        stderr = next.slice(0, MAX_GIT_CAPTURE_CHARS);
      } else {
        stderrTruncated = true;
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = error?.message || String(error);
      stderrHash.update(text);
      resolve({
        status: 'failed',
        exitCode: 127,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}${text}`,
        stdoutTail,
        stderrTail: tail(`${stderrTail}${text}`),
        stdoutTruncated,
        stderrTruncated,
        stdoutDigest: `sha256:${stdoutHash.digest('hex')}`,
        stderrDigest: `sha256:${stderrHash.digest('hex')}`,
      });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        stdoutTail,
        stderrTail,
        stdoutTruncated,
        stderrTruncated,
        stdoutDigest: `sha256:${stdoutHash.digest('hex')}`,
        stderrDigest: `sha256:${stderrHash.digest('hex')}`,
      });
    });
  });
}

function gitCommandEvidence(result) {
  const redactedStdout = redact(result?.stdoutTail || '');
  const redactedStderr = redact(result?.stderrTail || '');
  return {
    status: result?.status || 'failed',
    exitCode: result?.exitCode ?? null,
    signal: result?.signal || null,
    timedOut: Boolean(result?.timedOut),
    durationMs: Number(result?.durationMs || 0),
    stdoutDigest: result?.stdoutDigest || digestBytes(''),
    stderrDigest: result?.stderrDigest || digestBytes(''),
    stdoutTail: redactedStdout.text,
    stderrTail: redactedStderr.text,
    stdoutTruncated: Boolean(result?.stdoutTruncated),
    stderrTruncated: Boolean(result?.stderrTruncated),
    redactionCounts: mergeCounts(redactedStdout.counts, redactedStderr.counts),
  };
}

async function requireGitValue(args, cwd, failureCode, timeoutMs) {
  const result = await runGit(args, cwd, timeoutMs);
  const value = result.stdout.trim();
  if (result.status !== 'passed' || !value) {
    const error = new Error(failureCode);
    error.gitEvidence = gitCommandEvidence(result);
    throw error;
  }
  return { value, evidence: gitCommandEvidence(result) };
}

async function sourceCheckoutFingerprint(sourceRoot, timeoutMs) {
  const head = await requireGitValue(['rev-parse', '--verify', 'HEAD'], sourceRoot, 'shadow_source_head_unavailable', timeoutMs);
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], sourceRoot, timeoutMs);
  const worktreeDiff = await runGit(['diff', '--binary', '--full-index', '--no-ext-diff'], sourceRoot, timeoutMs);
  const stagedDiff = await runGit(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff'], sourceRoot, timeoutMs);
  if ([status, worktreeDiff, stagedDiff].some((result) => result.status !== 'passed')) {
    throw new Error('shadow_source_fingerprint_failed');
  }
  return {
    head: head.value,
    statusDigest: status.stdoutDigest,
    worktreeDiffDigest: worktreeDiff.stdoutDigest,
    stagedDiffDigest: stagedDiff.stdoutDigest,
    digest: digest({
      head: head.value,
      statusDigest: status.stdoutDigest,
      worktreeDiffDigest: worktreeDiff.stdoutDigest,
      stagedDiffDigest: stagedDiff.stdoutDigest,
    }),
  };
}

async function removeDisposableGitWorktree(sourceRoot, tmpParent, worktreeRoot, registered, timeoutMs) {
  const relative = path.relative(tmpParent, worktreeRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('shadow_worktree_cleanup_target_invalid');
  }
  let removeEvidence = null;
  let pruneEvidence = null;
  if (registered) {
    const removed = await runGit(['worktree', 'remove', '--force', worktreeRoot], sourceRoot, timeoutMs);
    removeEvidence = gitCommandEvidence(removed);
    if (removed.status !== 'passed') {
      await fs.rm(worktreeRoot, { recursive: true, force: true });
      const pruned = await runGit(['worktree', 'prune', '--expire', 'now'], sourceRoot, timeoutMs);
      pruneEvidence = gitCommandEvidence(pruned);
    }
  } else {
    await fs.rm(worktreeRoot, { recursive: true, force: true });
    const pruned = await runGit(['worktree', 'prune', '--expire', 'now'], sourceRoot, timeoutMs);
    pruneEvidence = gitCommandEvidence(pruned);
  }
  await fs.rm(tmpParent, { recursive: true, force: true });
  const listing = await runGit(['worktree', 'list', '--porcelain'], sourceRoot, timeoutMs);
  const retained = listing.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)))
    .some((entry) => entry === path.resolve(worktreeRoot));
  return {
    removed: listing.status === 'passed' && !retained,
    registered,
    remove: removeEvidence,
    prune: pruneEvidence,
    list: gitCommandEvidence(listing),
  };
}

function riskBudgetEvaluation(universe, input) {
  const strategy = normalizeStrategy(universe.strategy || universe.universe);
  const unresolvedRisks = asArray(universe.unresolvedRisks || universe.unresolved_risks);
  const avoidedRisks = asArray(universe.avoidedRisks || universe.avoided_risks);
  const exitCode = unresolvedRisks.length > avoidedRisks.length ? 20 : 0;
  const payload = {
    schemaVersion: 'synthi.codesite.shadowUniverseRiskBudget.v1',
    workspaceSlug: input.workspaceSlug,
    projectId: input.projectId,
    shadowJobRef: input.shadowJobRef,
    strategy,
    baseSnapshot: input.baseSnapshot,
    unresolvedRisks,
    avoidedRisks,
    selected: strategy === normalizeStrategy(input.selected?.strategy || input.selected),
  };
  const outputDigest = digest(payload);
  return {
    strategy,
    status: exitCode === 0 ? 'passed' : 'near_miss',
    exitCode,
    command: 'codesite-shadow-runner:evaluate-risk-budget',
    outputDigest,
    executionMode: 'risk_budget_evaluation',
    reasonCodes: exitCode === 0
      ? ['shadow_universe_executed', 'shadow_universe_risk_budget_passed']
      : ['shadow_universe_executed', 'shadow_universe_near_miss_preserved'],
    evidenceRefs: [
      `codesite:shadow-universe:${strategy}:${outputDigest}`,
      `codesite:shadow-job:${input.shadowJobRef}`,
    ],
  };
}

async function runCommand(spec, worktreeRoot, allowed) {
  if (!commandIsAllowed(spec.command, allowed)) {
    return {
      label: spec.label,
      command: spec.command,
      args: spec.args,
      status: 'blocked',
      exitCode: 126,
      reasonCode: 'shadow_command_not_allowed',
      evidenceDigest: digest({ command: spec.command, args: spec.args, blocked: true }),
    };
  }
  const cwd = resolveInsideWorktree(worktreeRoot, spec.cwd || '.', 'shadow_command_cwd');
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(spec.command, spec.args || [], {
      cwd,
      env: commandEnvironment(worktreeRoot),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, spec.timeoutMs || normalizeTimeout());

    child.stdout.on('data', (chunk) => {
      stdout = tail(`${stdout}${chunk.toString('utf8')}`);
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(`${stderr}${chunk.toString('utf8')}`);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      const redactedStdout = redact(stdout);
      const redactedStderr = redact(`${stderr}${error?.message || String(error)}`);
      const record = {
        label: spec.label,
        command: spec.command,
        args: spec.args || [],
        status: 'failed',
        exitCode: 127,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTail: redactedStdout.text,
        stderrTail: tail(redactedStderr.text),
        stdoutDigest: digest(redactedStdout.text),
        stderrDigest: digest(redactedStderr.text),
        redactionCounts: mergeCounts(redactedStdout.counts, redactedStderr.counts),
      };
      resolve({ ...record, evidenceDigest: digest(record) });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const redactedStdout = redact(stdout);
      const redactedStderr = redact(stderr);
      const record = {
        label: spec.label,
        command: spec.command,
        args: spec.args || [],
        status: exitCode === 0 && !timedOut ? 'passed' : 'failed',
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTail: redactedStdout.text,
        stderrTail: redactedStderr.text,
        stdoutDigest: digest(redactedStdout.text),
        stderrDigest: digest(redactedStderr.text),
        redactionCounts: mergeCounts(redactedStdout.counts, redactedStderr.counts),
      };
      resolve({ ...record, evidenceDigest: digest(record) });
    });
  });
}

async function executeGitPatchUniverse(universe, input, plan) {
  const strategy = normalizeStrategy(universe.strategy || universe.universe);
  const timeoutMs = plan.timeoutMs || normalizeTimeout();
  let artifacts;
  try {
    artifacts = patchArtifactsForStrategy(plan, strategy);
  } catch (error) {
    return failedGitPatchUniverse(strategy, input, error, {
      failurePhase: 'artifact_resolution',
      materialized: false,
      applied: false,
    });
  }
  if (!artifacts.length) {
    return failedGitPatchUniverse(strategy, input, new Error('shadow_universe_patch_artifact_required'), {
      failurePhase: 'artifact_resolution',
      materialized: false,
      applied: false,
    });
  }
  const invalidArtifact = artifacts.find((artifact) => artifact.digest !== artifact.computedDigest);
  if (invalidArtifact) {
    return failedGitPatchUniverse(strategy, input, new Error('shadow_patch_artifact_digest_mismatch'), {
      failurePhase: 'artifact_digest',
      materialized: false,
      applied: false,
      patchEvidence: [{
        artifactId: invalidArtifact.id,
        digest: invalidArtifact.digest,
        computedDigest: invalidArtifact.computedDigest,
        byteLength: invalidArtifact.byteLength,
        digestVerified: false,
        check: null,
        apply: null,
      }],
    });
  }

  const allowed = allowedRoot();
  let sourceRoot;
  try {
    const allowedReal = await fs.realpath(allowed);
    const candidate = resolveInside(allowedReal, plan.repoRoot, 'repo_root');
    sourceRoot = await fs.realpath(candidate);
    const sourceRelative = path.relative(allowedReal, sourceRoot);
    if (sourceRelative && (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative))) {
      throw new Error('repo_root_outside_allowed_root');
    }
  } catch (error) {
    return failedGitPatchUniverse(strategy, input, error, {
      failurePhase: 'source_resolution',
      materialized: false,
      applied: false,
    });
  }

  let base;
  let sourceBefore;
  try {
    base = await requireGitValue(
      ['rev-parse', '--verify', `${plan.baseCommit}^{commit}`],
      sourceRoot,
      'shadow_git_base_commit_not_found',
      timeoutMs,
    );
    if (base.value.toLowerCase() !== plan.baseCommit) {
      throw new Error('shadow_git_base_commit_mismatch');
    }
    sourceBefore = await sourceCheckoutFingerprint(sourceRoot, timeoutMs);
  } catch (error) {
    return failedGitPatchUniverse(strategy, input, error, {
      failurePhase: 'base_commit_verification',
      materialized: false,
      applied: false,
      baseCommit: plan.baseCommit,
      baseCommitEvidence: error?.gitEvidence || base?.evidence || null,
    });
  }

  const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), `codesite-shadow-git-${strategy || 'universe'}-`));
  const worktreeRoot = path.join(tmpParent, 'worktree');
  const artifactRoot = path.join(tmpParent, 'artifacts');
  let registered = false;
  let materialized = false;
  let applied = false;
  let beforeTree = null;
  let afterTree = null;
  let provisional = null;
  const patchEvidence = [];
  let materializationEvidence = null;
  let cleanupEvidence = null;

  try {
    await fs.mkdir(artifactRoot, { recursive: true });
    const add = await runGit(
      ['worktree', 'add', '--detach', worktreeRoot, plan.baseCommit],
      sourceRoot,
      timeoutMs,
    );
    materializationEvidence = gitCommandEvidence(add);
    if (add.status !== 'passed') throw shadowGitError('shadow_git_worktree_materialization_failed', add);
    registered = true;

    const worktreeCommit = await requireGitValue(
      ['rev-parse', '--verify', 'HEAD'],
      worktreeRoot,
      'shadow_git_worktree_head_unavailable',
      timeoutMs,
    );
    if (worktreeCommit.value.toLowerCase() !== plan.baseCommit) {
      throw new Error('shadow_git_worktree_base_mismatch');
    }
    const before = await requireGitValue(
      ['rev-parse', '--verify', 'HEAD^{tree}'],
      worktreeRoot,
      'shadow_git_before_tree_unavailable',
      timeoutMs,
    );
    beforeTree = before.value;
    materialized = true;

    for (const artifact of artifacts) {
      const patchPath = path.join(artifactRoot, `${artifact.digest.slice('sha256:'.length)}.patch`);
      await fs.writeFile(patchPath, artifact.bytes, { flag: 'wx' }).catch(async (error) => {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await fs.readFile(patchPath);
        if (digestBytes(existing) !== artifact.digest) throw new Error('shadow_patch_artifact_temp_collision');
      });
      const evidence = {
        artifactId: artifact.id,
        digest: artifact.digest,
        computedDigest: artifact.computedDigest,
        byteLength: artifact.byteLength,
        digestVerified: true,
        check: null,
        apply: null,
      };
      const checked = await runGit(
        ['apply', '--check', '--index', '--whitespace=nowarn', patchPath],
        worktreeRoot,
        timeoutMs,
      );
      evidence.check = gitCommandEvidence(checked);
      patchEvidence.push(evidence);
      if (checked.status !== 'passed') {
        provisional = failedGitPatchUniverse(strategy, input, new Error('shadow_patch_preimage_check_failed'), {
          failurePhase: 'preimage_check',
          materialized,
          applied: false,
          baseCommit: plan.baseCommit,
          beforeTree,
          afterTree: beforeTree,
          patchEvidence,
        });
        break;
      }

      const appliedResult = await runGit(
        ['apply', '--index', '--whitespace=nowarn', patchPath],
        worktreeRoot,
        timeoutMs,
      );
      evidence.apply = gitCommandEvidence(appliedResult);
      if (appliedResult.status !== 'passed') {
        provisional = failedGitPatchUniverse(strategy, input, new Error('shadow_patch_apply_failed'), {
          failurePhase: 'patch_apply',
          materialized,
          applied: false,
          baseCommit: plan.baseCommit,
          beforeTree,
          afterTree: beforeTree,
          patchEvidence,
        });
        break;
      }
    }

    if (!provisional) {
      const after = await requireGitValue(
        ['write-tree'],
        worktreeRoot,
        'shadow_git_after_tree_unavailable',
        timeoutMs,
      );
      afterTree = after.value;
      const names = await runGit(['diff', '--cached', '--name-only', '-z', '--no-ext-diff'], worktreeRoot, timeoutMs);
      const stagedDiff = await runGit(['diff', '--cached', '--binary', '--full-index', '--no-ext-diff'], worktreeRoot, timeoutMs);
      if (names.status !== 'passed' || stagedDiff.status !== 'passed') {
        throw new Error('shadow_git_apply_evidence_unavailable');
      }
      const changedPaths = names.stdout.split('\0').filter(Boolean);
      if (!changedPaths.length || beforeTree === afterTree) {
        throw new Error('shadow_patch_produced_no_tree_change');
      }
      applied = patchEvidence.length === artifacts.length
        && patchEvidence.every((evidence) => evidence.check?.status === 'passed' && evidence.apply?.status === 'passed');
      if (!applied) throw new Error('shadow_patch_apply_incomplete');
      // Workstream E: run the plan's impacted validation commands against the
      // patched worktree. Commands use the same allowlist + redaction pipeline
      // as copy-command mode; failures downgrade the universe to near_miss.
      const commands = [];
      if (plan.commands.length) {
        const allowed = allowedBinaries();
        for (const command of plan.commands) {
          const result = await runCommand(command, worktreeRoot, allowed);
          commands.push(result);
          if (result.status !== 'passed' && plan.stopOnFailure !== false && plan.stop_on_failure !== false) break;
        }
      }
      const commandsPassed = commands.every((command) => command.status === 'passed');
      const outputDigest = digest({
        strategy,
        baseCommit: plan.baseCommit,
        beforeTree,
        afterTree,
        patchDigests: artifacts.map((artifact) => artifact.digest),
        stagedDiffDigest: stagedDiff.stdoutDigest,
        changedPaths,
        commandEvidence: commands.map((command) => command.evidenceDigest || null),
      });
      provisional = {
        strategy,
        status: commandsPassed ? 'passed' : 'near_miss',
        exitCode: commandsPassed ? 0
          : commands.find((command) => command.status !== 'passed')?.exitCode ?? 1,
        command: 'codesite-shadow-runner:git-worktree-patch-execution',
        outputDigest,
        executionMode: 'git_worktree_patch_execution',
        executed: true,
        materialized: true,
        applied: true,
        baseCommit: plan.baseCommit,
        baseCommitEvidence: base.evidence,
        beforeTree,
        afterTree,
        changedPaths,
        stagedDiffDigest: stagedDiff.stdoutDigest,
        materializationEvidence,
        patchEvidence,
        commands,
        durationMs: commands.reduce((sum, command) => sum + (Number(command.durationMs) || 0), 0),
        reasonCodes: [
          'shadow_universe_executed',
          'shadow_git_worktree_materialized',
          'shadow_patch_digest_verified',
          'shadow_patch_preimage_verified',
          'shadow_patch_applied',
          'shadow_after_tree_captured',
          ...(commands.length ? [
            ...(commandsPassed ? ['shadow_universe_repo_commands_passed'] : ['shadow_universe_repo_commands_failed']),
          ] : []),
        ],
        evidenceRefs: [
          `codesite:shadow-job:${input.shadowJobRef}`,
          `codesite:shadow-base-commit:${plan.baseCommit}`,
          `codesite:shadow-before-tree:${beforeTree}`,
          `codesite:shadow-after-tree:${afterTree}`,
          `codesite:shadow-staged-diff:${stagedDiff.stdoutDigest}`,
          ...patchEvidence.flatMap((evidence) => [
            `codesite:shadow-patch:${evidence.digest}`,
            `codesite:shadow-patch-check:${digest(evidence.check)}`,
            `codesite:shadow-patch-apply:${digest(evidence.apply)}`,
          ]),
          ...commands.map((command) => `codesite:shadow-command:${strategy}:${command.label}:${command.evidenceDigest}`),
        ],
      };
    }
  } catch (error) {
    provisional = failedGitPatchUniverse(strategy, input, error, {
      failurePhase: materialized ? 'patch_apply' : 'materialization',
      materialized,
      applied,
      baseCommit: plan.baseCommit,
      beforeTree,
      afterTree,
      materializationEvidence,
      patchEvidence,
      gitEvidence: error?.gitEvidence || null,
    });
  } finally {
    cleanupEvidence = await removeDisposableGitWorktree(
      sourceRoot,
      tmpParent,
      worktreeRoot,
      registered,
      timeoutMs,
    ).catch((error) => ({ removed: false, error: error?.message || String(error) }));
  }

  const sourceAfter = await sourceCheckoutFingerprint(sourceRoot, timeoutMs).catch(() => null);
  const sourceUnchanged = Boolean(sourceAfter && sourceBefore.digest === sourceAfter.digest);
  const cleanupPassed = cleanupEvidence?.removed === true;
  if (!sourceUnchanged || !cleanupPassed) {
    provisional = failedGitPatchUniverse(
      strategy,
      input,
      new Error(!sourceUnchanged ? 'shadow_source_checkout_changed' : 'shadow_git_worktree_cleanup_failed'),
      {
        ...provisional,
        failurePhase: !sourceUnchanged ? 'source_integrity' : 'cleanup',
        executed: false,
      },
    );
  }
  return {
    ...provisional,
    // Workstream E: `executed` means real execution happened (patches applied
    // in the disposable worktree). Command outcomes downgrade status to
    // near_miss but do NOT negate executed — that's the forecast distinction.
    executed: provisional.materialized === true && provisional.applied === true,
    sourceCheckout: {
      unchanged: sourceUnchanged,
      beforeDigest: sourceBefore.digest,
      afterDigest: sourceAfter?.digest || null,
    },
    cleanup: cleanupEvidence,
    worktreeRetained: false,
    worktreePath: null,
  };
}

function shadowGitError(code, result) {
  const error = new Error(code);
  error.gitEvidence = gitCommandEvidence(result);
  return error;
}

function failedGitPatchUniverse(strategy, input, error, details = {}) {
  const message = error?.message || String(error);
  const outputDigest = digest({ strategy, message, details });
  const conflictEvidence = details.patchEvidence?.at(-1)?.check?.status === 'failed'
    ? {
      artifactDigest: details.patchEvidence.at(-1).digest,
      phase: details.failurePhase,
      check: details.patchEvidence.at(-1).check,
      digest: digest(details.patchEvidence.at(-1).check),
    }
    : null;
  return {
    strategy,
    status: 'failed',
    exitCode: details.gitEvidence?.exitCode ?? details.patchEvidence?.at(-1)?.check?.exitCode ?? 1,
    command: 'codesite-shadow-runner:git-worktree-patch-execution',
    outputDigest,
    executionMode: 'git_worktree_patch_execution',
    executed: false,
    materialized: details.materialized === true,
    applied: false,
    baseCommit: details.baseCommit || null,
    baseCommitEvidence: details.baseCommitEvidence || null,
    beforeTree: details.beforeTree || null,
    afterTree: details.afterTree || null,
    failurePhase: details.failurePhase || 'unknown',
    failureCode: message,
    materializationEvidence: details.materializationEvidence || null,
    patchEvidence: details.patchEvidence || [],
    conflictEvidence,
    gitEvidence: details.gitEvidence || error?.gitEvidence || null,
    reasonCodes: [
      'shadow_universe_execution_failed',
      ...(details.materialized ? ['shadow_git_worktree_materialized'] : []),
      ...(conflictEvidence ? ['shadow_patch_preimage_conflict'] : []),
      message,
    ],
    evidenceRefs: [
      `codesite:shadow-job:${input.shadowJobRef}`,
      `codesite:shadow-execution-failed:${outputDigest}`,
      ...(conflictEvidence ? [`codesite:shadow-conflict:${conflictEvidence.digest}`] : []),
    ],
  };
}

async function executeRepoUniverse(universe, input, plan) {
  const strategy = normalizeStrategy(universe.strategy || universe.universe);
  const root = allowedRoot();
  const sourceRoot = resolveInside(root, plan.repoRoot, 'repo_root');
  const tmpParent = await fs.mkdtemp(path.join(os.tmpdir(), `codesite-shadow-${strategy || 'universe'}-`));
  const worktreeRoot = path.join(tmpParent, 'worktree');
  try {
    await copyRepository(sourceRoot, worktreeRoot, copyExcludes(plan));
    const patchResults = [];
    for (const patch of patchesForStrategy(plan, strategy)) {
      patchResults.push(await applyPatch(worktreeRoot, patch));
    }
    const allowed = allowedBinaries();
    const commands = [];
    for (const command of plan.commands) {
      const result = await runCommand(command, worktreeRoot, allowed);
      commands.push(result);
      if (result.status !== 'passed' && plan.stopOnFailure !== false && plan.stop_on_failure !== false) break;
    }
    const passed = commands.length > 0 && commands.every((command) => command.status === 'passed');
    const outputDigest = digest({ strategy, patchResults, commands });
    const commandRefs = commands.map((command) => `codesite:shadow-command:${strategy}:${command.label}:${command.evidenceDigest}`);
    return {
      strategy,
      status: passed ? 'passed' : 'near_miss',
      exitCode: passed ? 0 : commands.find((command) => command.status !== 'passed')?.exitCode ?? 20,
      command: 'codesite-shadow-runner:repo-command-execution',
      outputDigest,
      executionMode: 'repo_command_execution',
      reasonCodes: [
        'shadow_universe_executed',
        passed ? 'shadow_universe_repo_commands_passed' : 'shadow_universe_repo_commands_failed',
      ],
      patches: patchResults,
      commands,
      worktreeRetained: plan.keepWorktrees,
      worktreePath: plan.keepWorktrees ? worktreeRoot : null,
      evidenceRefs: [
        `codesite:shadow-universe:${strategy}:${outputDigest}`,
        `codesite:shadow-job:${input.shadowJobRef}`,
        ...commandRefs,
      ],
    };
  } catch (error) {
    const outputDigest = digest({ strategy, error: error?.message || String(error) });
    return {
      strategy,
      status: 'failed',
      exitCode: 1,
      command: 'codesite-shadow-runner:repo-command-execution',
      outputDigest,
      executionMode: 'repo_command_execution',
      reasonCodes: ['shadow_universe_executed', 'shadow_universe_execution_failed'],
      error: error?.message || String(error),
      evidenceRefs: [
        `codesite:shadow-universe:${strategy}:${outputDigest}`,
        `codesite:shadow-job:${input.shadowJobRef}`,
      ],
    };
  } finally {
    if (!plan.keepWorktrees) {
      await fs.rm(tmpParent, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function executeUniverse(universe, input, plan) {
  if (plan?.mode === 'git_worktree_patch_execution') return executeGitPatchUniverse(universe, input, plan);
  if (plan) return executeRepoUniverse(universe, input, plan);
  return riskBudgetEvaluation(universe, input);
}

async function emitResult(input, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const outputPath = input.outputPath || input.output_path || input.shadowRunnerOutputPath || input.shadow_runner_output_path || null;
  if (outputPath) {
    const outputRoot = path.resolve(process.env.SYNTHI_CODESITE_SHADOW_RUNNER_OUTPUT_ROOT || os.tmpdir());
    const resolved = path.resolve(outputPath);
    const relative = path.relative(outputRoot, resolved);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, text, 'utf8');
    }
  }
  process.stdout.write(text);
}

async function main() {
  const input = await readStdin();
  const plan = normalizeExecutionPlan(input);
  const universes = [];
  for (const universe of asArray(input.universes)) {
    universes.push(await executeUniverse(universe, input, plan));
  }
  const selected = normalizeStrategy(input.selected?.strategy || input.selected || universes.find((universe) => universe.exitCode === 0)?.strategy);
  const executionMode = plan?.mode === 'git_worktree_patch_execution'
    ? 'git_worktree_patch_execution'
    : plan
      ? 'repo_command_execution'
      : 'risk_budget_evaluation';
  const gitPatchExecutionComplete = executionMode === 'git_worktree_patch_execution'
    && universes.length > 0
    && universes.every((universe) => universe.executed === true
      && universe.materialized === true
      && universe.applied === true
      // Workstream E: a completed executed proof requires every validation
      // command to have passed; near_miss universes preserve the execution
      // evidence but must not satisfy the mature-proof bar.
      && universe.status === 'passed');
  const evidenceRefs = [
    `codesite:shadow-runner:${digest({ selected, universes, executionMode })}`,
    ...universes.flatMap((universe) => universe.evidenceRefs),
  ];

  await emitResult(input, {
    schemaVersion: 'synthi.codesite.shadowRunnerResult.v1',
    runner: 'codesite-shadow-runner',
    status: executionMode === 'git_worktree_patch_execution'
      ? (gitPatchExecutionComplete ? 'completed' : 'failed')
      : 'completed',
    executionMode,
    executed: executionMode === 'git_worktree_patch_execution' ? gitPatchExecutionComplete : undefined,
    selected,
    universes,
    evidenceRefs,
  });
}

try {
  await main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'synthi.codesite.shadowRunnerResult.v1',
    runner: 'codesite-shadow-runner',
    status: 'failed',
    error: error?.message || String(error),
    evidenceRefs: [`codesite:shadow-runner-failed:${digest(error?.message || String(error))}`],
  }, null, 2)}\n`);
}
