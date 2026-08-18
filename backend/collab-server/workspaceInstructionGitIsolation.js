'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { stripManagedInstructionBlocks } = require('./workspaceInstructionGitFilter');

const execFileAsync = promisify(execFile);

const MANAGED_ATTRIBUTES_PREFIX = '# Vectant managed instruction filters BEGIN ';
const MANAGED_ATTRIBUTES_SUFFIX = '# Vectant managed instruction filters END ';
const MANAGED_EXCLUDES_PREFIX = '# Vectant generated instruction files BEGIN ';
const MANAGED_EXCLUDES_SUFFIX = '# Vectant generated instruction files END ';
const FILTER_PREFIX = 'vectant-instructions-';
const STATE_DIRECTORY = 'info/vectant-instruction-filters';
const DEFAULT_SEPARATOR = '\n\n';
const FILTER_SCRIPT_PATH = path.join(__dirname, 'workspaceInstructionGitFilter.js');
const RUNTIME_FILTER_RELATIVE_PATH = '.synthi/vectant-instruction-git-filter.js';
// Git compares the physical working-tree stat cache before running the clean
// filter for `status`. A smudged tracked file therefore remains ` M` even when
// its cleaned object equals the index. The projection lifecycle must safely
// refresh the index after it has verified user bytes did not change.
const TRACKED_STATUS_LIMITATION = 'git_status_reports_smudged_tracked_projection_modified';

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value), 'utf8').digest('hex');
}

function chooseLineEnding(content) {
  return String(content).includes('\r\n') ? '\r\n' : '\n';
}

function requireSafeWorkspaceId(workspaceId) {
  const value = String(workspaceId || '').trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new Error('workspace_instruction_git_isolation_invalid_workspace_id');
  }
  return value;
}

function normalizeProjectionPath(projectionPath) {
  if (typeof projectionPath !== 'string' || !projectionPath.trim() || path.isAbsolute(projectionPath)) {
    throw new Error('workspace_instruction_git_isolation_invalid_projection_path');
  }
  const normalized = projectionPath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\r\n]/.test(part))) {
    throw new Error('workspace_instruction_git_isolation_projection_path_escape');
  }
  return parts.join('/');
}

function relativeProjectionPath(activeWorkspaceRoot, repoRoot, projectionPath) {
  const fromWorkspace = normalizeProjectionPath(projectionPath);
  const absolute = path.resolve(activeWorkspaceRoot, ...fromWorkspace.split('/'));
  const relative = path.relative(repoRoot, absolute).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('workspace_instruction_git_isolation_projection_outside_repository');
  }
  return normalizeProjectionPath(relative);
}

function shellQuote(value) {
  // Git executes filter commands through a shell.  POSIX single-quote escaping
  // is also accepted by Git for Windows' bundled sh, which is the relevant
  // shell for a local Git config on Windows.
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function attributePattern(repoRelativePath) {
  if (/^[A-Za-z0-9._/-]+$/.test(repoRelativePath)) return repoRelativePath;
  return JSON.stringify(repoRelativePath);
}

function excludePattern(repoRelativePath) {
  // .gitignore syntax has glob metacharacters. Escape them so this is the
  // exact synthetic file path rather than a broad ignore rule.
  const escaped = repoRelativePath
    .replace(/\\/g, '\\\\')
    .replace(/([*?\[\]!])/g, '\\$1')
    .replace(/ /g, '\\ ');
  return `/${escaped}`;
}

function excludeDirectoryPattern(repoRelativePath) {
  return `${excludePattern(repoRelativePath)}/`;
}

function managedSection(begin, end, body, lineEnding) {
  const lines = [begin, ...body, end];
  return `${lines.join(lineEnding)}${lineEnding}`;
}

function upsertManagedSection(existing, begin, end, body) {
  const content = String(existing || '');
  const lineEnding = chooseLineEnding(content);
  const section = managedSection(begin, end, body, lineEnding);
  const start = content.indexOf(begin);
  if (start >= 0) {
    const endStart = content.indexOf(end, start + begin.length);
    if (endStart >= 0) {
      let after = endStart + end.length;
      if (content.slice(after, after + 2) === '\r\n') after += 2;
      else if (content.slice(after, after + 1) === '\n') after += 1;
      return `${content.slice(0, start)}${section}${content.slice(after)}`;
    }
  }
  if (!content) return section;
  return `${content}${content.endsWith('\n') ? '' : lineEnding}${section}`;
}

function removeManagedSection(existing, begin, end) {
  const content = String(existing || '');
  const start = content.indexOf(begin);
  if (start < 0) return content;
  const endStart = content.indexOf(end, start + begin.length);
  if (endStart < 0) return content;
  let after = endStart + end.length;
  if (content.slice(after, after + 2) === '\r\n') after += 2;
  else if (content.slice(after, after + 1) === '\n') after += 1;
  return `${content.slice(0, start)}${content.slice(after)}`;
}

async function atomicWrite(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const existingStat = await fs.promises.stat(filePath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.vectant-${crypto.randomBytes(6).toString('hex')}.tmp`);
  const handle = await fs.promises.open(temporaryPath, 'w', existingStat ? existingStat.mode : undefined);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function installRuntimeFilter(activeWorkspaceRoot, sourcePath) {
  const target = path.resolve(activeWorkspaceRoot, RUNTIME_FILTER_RELATIVE_PATH);
  const relative = path.relative(activeWorkspaceRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('workspace_instruction_git_isolation_runtime_filter_path_escape');
  }
  const source = await fs.promises.readFile(sourcePath, 'utf8');
  const existing = await fs.promises.readFile(target, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing !== source) await atomicWrite(target, source);
  return target;
}

async function runGit(cwd, args, options = {}) {
  return execFileAsync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function gitOutput(cwd, args) {
  const { stdout } = await runGit(cwd, args);
  return stdout.trim();
}

async function findContainingGitRepository(activeWorkspaceRoot) {
  const root = await fs.promises.realpath(activeWorkspaceRoot).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('workspace_instruction_git_isolation_workspace_missing');
    throw error;
  });
  try {
    const repoRoot = await gitOutput(root, ['rev-parse', '--show-toplevel']);
    // Ask Git for absolute paths.  Relative `--git-path` output is dependent
    // on the Git invocation context (and is particularly subtle for
    // worktrees), whereas the absolute form names the exact info directory
    // Git will consult.
    const attributesPath = await gitOutput(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes']);
    const excludePath = await gitOutput(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
    const stateDirectory = await gitOutput(root, ['rev-parse', '--path-format=absolute', '--git-path', STATE_DIRECTORY]);
    return { activeWorkspaceRoot: root, repoRoot: path.resolve(repoRoot), attributesPath, excludePath, stateDirectory };
  } catch (error) {
    const detail = String(error.stderr || error.message || '');
    if (/not a git repository/i.test(detail)) return null;
    throw error;
  }
}

async function isTracked(repoRoot, repoRelativePath) {
  try {
    await runGit(repoRoot, ['ls-files', '--error-unmatch', '--', repoRelativePath]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function hasStagedChange(repoRoot, repoRelativePath) {
  try {
    await runGit(repoRoot, ['diff', '--cached', '--quiet', '--', repoRelativePath]);
    return false;
  } catch (error) {
    if (error.code === 1) return true;
    throw error;
  }
}

async function existingFilter(repoRoot, repoRelativePath) {
  const output = await gitOutput(repoRoot, ['check-attr', 'filter', '--', repoRelativePath]);
  const match = output.match(/^.+: filter: (.+)$/m);
  return match && match[1] !== 'unspecified' ? match[1] : null;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') throw new Error('workspace_instruction_git_isolation_options_required');
  const workspaceId = requireSafeWorkspaceId(options.workspaceId);
  if (!options.activeWorkspaceRoot || !options.block || !Array.isArray(options.projections)) {
    throw new Error('workspace_instruction_git_isolation_missing_required_options');
  }
  if (!String(options.block).includes('<!-- Vectant_MANAGED_INSTRUCTIONS_BEGIN') || !String(options.block).includes('<!-- Vectant_MANAGED_INSTRUCTIONS_END -->')) {
    throw new Error('workspace_instruction_git_isolation_invalid_managed_block');
  }
  return {
    workspaceId,
    activeWorkspaceRoot: path.resolve(String(options.activeWorkspaceRoot)),
    block: String(options.block),
    separator: typeof options.separator === 'string' ? options.separator : DEFAULT_SEPARATOR,
    projections: options.projections.map((projection) => ({
      path: normalizeProjectionPath(projection?.path),
      ownership: projection?.ownership,
    })),
    filterScriptSourcePath: path.resolve(options.filterScriptSourcePath || FILTER_SCRIPT_PATH),
  };
}

function filterNameFor(workspaceId, activeWorkspaceRoot) {
  return `${FILTER_PREFIX}${sha256(`${workspaceId}\u0000${path.resolve(activeWorkspaceRoot)}`).slice(0, 24)}`;
}

async function configureWorkspaceInstructionGitIsolation(options) {
  const input = validateOptions(options);
  const git = await findContainingGitRepository(input.activeWorkspaceRoot);
  if (!git) return { configured: false, reason: 'not_a_git_workspace' };

  const filterName = filterNameFor(input.workspaceId, git.activeWorkspaceRoot);
  const sectionId = sha256(`${input.workspaceId}\u0000${git.activeWorkspaceRoot}`).slice(0, 24);
  const attributesBegin = `${MANAGED_ATTRIBUTES_PREFIX}${sectionId}`;
  const attributesEnd = `${MANAGED_ATTRIBUTES_SUFFIX}${sectionId}`;
  const excludesBegin = `${MANAGED_EXCLUDES_PREFIX}${sectionId}`;
  const excludesEnd = `${MANAGED_EXCLUDES_SUFFIX}${sectionId}`;
  const projections = [];

  for (const projection of input.projections) {
    if (!['existing-user-file', 'synthetic-only'].includes(projection.ownership)) {
      throw new Error('workspace_instruction_git_isolation_invalid_projection_ownership');
    }
    const repoRelativePath = relativeProjectionPath(git.activeWorkspaceRoot, git.repoRoot, projection.path);
    const activeFilter = await existingFilter(git.repoRoot, repoRelativePath);
    if (activeFilter && activeFilter !== filterName) {
      const error = new Error(`workspace_instruction_git_isolation_filter_conflict:${repoRelativePath}`);
      error.code = 'WORKSPACE_INSTRUCTION_GIT_FILTER_CONFLICT';
      error.projectionPath = repoRelativePath;
      error.filter = activeFilter;
      throw error;
    }
    projections.push({
      ...projection,
      repoRelativePath,
      tracked: await isTracked(git.repoRoot, repoRelativePath),
    });
  }

  // The Git configuration is consumed by terminal-launched Git, not by the
  // collab server. Install a self-contained filter under this exact active
  // workspace root so the configured command remains available in that
  // runtime. `.synthi/` is an internal runtime directory and is excluded by
  // this module's own local-only exclude section below.
  const runtimeFilterPath = await installRuntimeFilter(git.activeWorkspaceRoot, input.filterScriptSourcePath);
  const runtimeDirectoryRelativePath = relativeProjectionPath(git.activeWorkspaceRoot, git.repoRoot, '.synthi');

  const statePath = path.join(git.stateDirectory, `${filterName}.json`);
  await atomicWrite(statePath, JSON.stringify({
    format: 1,
    workspaceId: input.workspaceId,
    filterName,
    separator: input.separator,
    block: input.block,
  }, null, 2) + '\n');

  const cleanCommand = `${shellQuote(process.execPath)} ${shellQuote(runtimeFilterPath)} --clean --state ${shellQuote(statePath)}`;
  const smudgeCommand = `${shellQuote(process.execPath)} ${shellQuote(runtimeFilterPath)} --smudge --state ${shellQuote(statePath)}`;
  await runGit(git.repoRoot, ['config', '--local', `filter.${filterName}.clean`, cleanCommand]);
  await runGit(git.repoRoot, ['config', '--local', `filter.${filterName}.smudge`, smudgeCommand]);
  await runGit(git.repoRoot, ['config', '--local', `filter.${filterName}.required`, 'true']);

  const currentAttributes = await fs.promises.readFile(git.attributesPath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const nextAttributes = upsertManagedSection(
    currentAttributes,
    attributesBegin,
    attributesEnd,
    // A managed Markdown projection is byte-sensitive: the clean filter must
    // return the exact user representation. Disable Git's independent text
    // normalization for these paths so a global core.autocrlf setting cannot
    // leave a permanent phantom modification after clean/smudge processing.
    projections.map((projection) => `${attributePattern(projection.repoRelativePath)} filter=${filterName} -text`),
  );
  if (nextAttributes !== currentAttributes) await atomicWrite(git.attributesPath, nextAttributes);

  const currentExcludes = await fs.promises.readFile(git.excludePath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const nextExcludes = upsertManagedSection(
    currentExcludes,
    excludesBegin,
    excludesEnd,
    [
      excludeDirectoryPattern(runtimeDirectoryRelativePath),
      ...projections
        .filter((projection) => projection.ownership === 'synthetic-only')
        .map((projection) => excludePattern(projection.repoRelativePath)),
    ],
  );
  if (nextExcludes !== currentExcludes) await atomicWrite(git.excludePath, nextExcludes);

  return {
    configured: true,
    repoRoot: git.repoRoot,
    activeWorkspaceRoot: git.activeWorkspaceRoot,
    filterName,
    runtimeFilterPath,
    statePath,
    attributesPath: git.attributesPath,
    excludePath: git.excludePath,
    projections,
    trackedStatusIsolation: projections.some((projection) => projection.tracked)
      ? { requiresRefreshAfterProjection: true, limitation: TRACKED_STATUS_LIMITATION }
      : { requiresRefreshAfterProjection: false },
  };
}

/**
 * Refresh Git's stat/index entry only after the lifecycle has proved that its
 * own reconciliation did not change user-owned bytes. `git add` deliberately
 * goes through the clean filter, so the runtime Vectant block never enters the
 * index. It is not a substitute for the workspace file lock: a caller must
 * serialize projection writes and this helper to close the read/add TOCTOU.
 */
async function refreshTrackedProjectionStat(options) {
  const activeWorkspaceRoot = path.resolve(String(options?.activeWorkspaceRoot || ''));
  const workspaceId = requireSafeWorkspaceId(options?.workspaceId);
  const projectionPath = normalizeProjectionPath(options?.projectionPath);
  const expectedUserHash = String(options?.expectedUserHash || '');
  if (!/^[a-f0-9]{64}$/i.test(expectedUserHash)) {
    throw new Error('workspace_instruction_git_isolation_invalid_expected_user_hash');
  }
  const git = await findContainingGitRepository(activeWorkspaceRoot);
  if (!git) return { refreshed: false, reason: 'not_a_git_workspace' };
  // Bind this exact workspace identity to an installed local filter. A stale
  // caller cannot use the helper to stage arbitrary files without the
  // workspace's filter configuration.
  const filterName = filterNameFor(workspaceId, git.activeWorkspaceRoot);
  const repoRelativePath = relativeProjectionPath(git.activeWorkspaceRoot, git.repoRoot, projectionPath);
  if (!await isTracked(git.repoRoot, repoRelativePath)) {
    return { refreshed: false, reason: 'not_tracked' };
  }
  const configuredFilter = await existingFilter(git.repoRoot, repoRelativePath);
  if (configuredFilter !== filterName) {
    return { refreshed: false, reason: 'filter_not_owned_by_workspace' };
  }
  if (await hasStagedChange(git.repoRoot, repoRelativePath)) {
    return { refreshed: false, reason: 'not_refreshed_staged_change_present' };
  }
  const physicalPath = path.resolve(git.activeWorkspaceRoot, ...projectionPath.split('/'));
  const withinWorkspace = path.relative(git.activeWorkspaceRoot, physicalPath);
  if (withinWorkspace.startsWith('..') || path.isAbsolute(withinWorkspace)) {
    throw new Error('workspace_instruction_git_isolation_projection_path_escape');
  }
  const before = await fs.promises.readFile(physicalPath);
  if (sha256(stripManagedInstructionBlocks(before)) !== expectedUserHash) {
    return { refreshed: false, reason: 'not_refreshed_user_content_changed' };
  }
  await runGit(git.repoRoot, ['add', '--', repoRelativePath]);
  const after = await fs.promises.readFile(physicalPath);
  if (sha256(stripManagedInstructionBlocks(after)) !== expectedUserHash) {
    return {
      refreshed: false,
      reason: 'projection_changed_during_refresh',
      // The workspace lock/retry owner decides how to recover: blindly
      // resetting the index could discard a user stage made concurrently.
    };
  }
  return { refreshed: true, repoRelativePath };
}

async function removeWorkspaceInstructionGitIsolation(options) {
  const workspaceId = requireSafeWorkspaceId(options?.workspaceId);
  const activeWorkspaceRoot = path.resolve(String(options?.activeWorkspaceRoot || ''));
  const git = await findContainingGitRepository(activeWorkspaceRoot);
  if (!git) return { removed: false, reason: 'not_a_git_workspace' };

  const filterName = filterNameFor(workspaceId, git.activeWorkspaceRoot);
  const sectionId = sha256(`${workspaceId}\u0000${git.activeWorkspaceRoot}`).slice(0, 24);
  const attributesBegin = `${MANAGED_ATTRIBUTES_PREFIX}${sectionId}`;
  const attributesEnd = `${MANAGED_ATTRIBUTES_SUFFIX}${sectionId}`;
  const excludesBegin = `${MANAGED_EXCLUDES_PREFIX}${sectionId}`;
  const excludesEnd = `${MANAGED_EXCLUDES_SUFFIX}${sectionId}`;

  for (const [filePath, begin, end] of [
    [git.attributesPath, attributesBegin, attributesEnd],
    [git.excludePath, excludesBegin, excludesEnd],
  ]) {
    const existing = await fs.promises.readFile(filePath, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    const next = removeManagedSection(existing, begin, end);
    if (next !== existing) await atomicWrite(filePath, next);
  }

  await runGit(git.repoRoot, ['config', '--local', '--remove-section', `filter.${filterName}`]).catch((error) => {
    // Git versions return either a lookup status or 128 with this diagnostic
    // when the requested optional section does not exist. That is the normal
    // no-op cleanup case for a newly created workspace; retain other errors.
    const missingSection = typeof error?.stderr === 'string'
      && error.stderr.includes(`no such section: filter.${filterName}`);
    if (!missingSection) throw error;
  });
  await fs.promises.unlink(path.join(git.stateDirectory, `${filterName}.json`)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const runtimeFilterPath = path.resolve(git.activeWorkspaceRoot, RUNTIME_FILTER_RELATIVE_PATH);
  await fs.promises.unlink(runtimeFilterPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await fs.promises.rmdir(path.dirname(runtimeFilterPath)).catch((error) => {
    // Preserve an existing `.synthi/` directory (and anything created by a
    // concurrent subsystem); remove only the empty directory this module made.
    if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
  });
  return { removed: true, repoRoot: git.repoRoot, filterName };
}

module.exports = {
  DEFAULT_SEPARATOR,
  FILTER_PREFIX,
  FILTER_SCRIPT_PATH,
  RUNTIME_FILTER_RELATIVE_PATH,
  TRACKED_STATUS_LIMITATION,
  appendManagedSection: upsertManagedSection,
  configureWorkspaceInstructionGitIsolation,
  excludePattern,
  filterNameFor,
  findContainingGitRepository,
  normalizeProjectionPath,
  refreshTrackedProjectionStat,
  removeManagedSection,
  removeWorkspaceInstructionGitIsolation,
  relativeProjectionPath,
};
