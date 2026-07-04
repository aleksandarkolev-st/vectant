const fs = require('fs');
const path = require('path');
const config = require('./config');
const gitService = require('./gitService');
const logger = require('./logger').child({ component: 'workspace-prep-manager' });
const repoCache = require('./repoCache');
const { planWorkspacePrep } = require('./workspacePrepPlanner');
const { executeWorkspacePrepTask, getWorkspacePrepMode } = require('./workspacePrepExecutor');

const STATUS_VERSION = 1;
const MAX_PARALLEL = Math.max(1, Number(config.WORKSPACE_PREP_MAX_PARALLEL) || 1);

const scopeStates = new Map();
const queue = [];
let activeRuns = 0;
let runnerScheduled = false;

function scopeKey(slug, userId) {
  return userId ? `${slug}::${userId}` : slug;
}

function safeScopeFileName(slug, userId) {
  const base = String(slug || 'workspace').replace(/[^A-Za-z0-9._-]/g, '_');
  const scoped = userId ? `${base}__${String(userId).replace(/[^A-Za-z0-9._-]/g, '_')}` : base;
  return `${scoped}.json`;
}

function metadataPathForScope(slug, userId) {
  return path.join(config.WORKSPACE_PREP_STATE_DIR, safeScopeFileName(slug, userId));
}

function createDefaultState(slug, userId) {
  return {
    slug,
    userId: userId || null,
    key: scopeKey(slug, userId),
    metadataPath: metadataPathForScope(slug, userId),
    loaded: false,
    loadingPromise: null,
    queuedPlan: null,
    pendingPlan: null,
    pendingTrigger: null,
    pendingForce: false,
    queueListed: false,
    state: 'idle',
    trigger: null,
    fingerprint: null,
    manifests: [],
    tasks: [],
    error: null,
    updatedAt: null,
    lastAttemptAt: null,
    lastPreparedAt: null,
    lastRequestedAt: null,
    runningFingerprint: null,
  };
}

function getState(slug, userId) {
  const key = scopeKey(slug, userId);
  if (!scopeStates.has(key)) {
    scopeStates.set(key, createDefaultState(slug, userId));
  }
  return scopeStates.get(key);
}

function cloneTaskStatus(task) {
  return {
    id: task.id,
    ecosystem: task.ecosystem,
    rootPath: task.rootPath || '',
    manifestPaths: Array.isArray(task.manifestPaths) ? [...task.manifestPaths] : [],
    commandSummary: task.commandSummary,
    status: task.status || 'pending',
    message: task.message || null,
    missingTool: task.missingTool || null,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    durationMs: task.durationMs || null,
    exitCode: typeof task.exitCode === 'number' ? task.exitCode : null,
    signal: task.signal || null,
    stdoutTail: task.stdoutTail || '',
    stderrTail: task.stderrTail || '',
  };
}

function publicStatus(state) {
  return {
    version: STATUS_VERSION,
    slug: state.slug,
    userId: state.userId,
    state: state.state,
    executorMode: getWorkspacePrepMode(),
    trigger: state.trigger,
    fingerprint: state.fingerprint,
    manifests: [...state.manifests],
    tasks: state.tasks.map(cloneTaskStatus),
    error: state.error,
    updatedAt: state.updatedAt,
    lastRequestedAt: state.lastRequestedAt,
    lastAttemptAt: state.lastAttemptAt,
    lastPreparedAt: state.lastPreparedAt,
  };
}

async function writeJsonAtomic(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2));
  await fs.promises.rename(tempPath, filePath);
}

async function persistState(state) {
  state.updatedAt = Date.now();
  await writeJsonAtomic(state.metadataPath, publicStatus(state));
}

async function loadState(state) {
  if (state.loaded) return state;
  if (state.loadingPromise) return state.loadingPromise;

  state.loadingPromise = (async () => {
    try {
      const raw = await fs.promises.readFile(state.metadataPath, 'utf8');
      const persisted = JSON.parse(raw);
      state.state = persisted.state || 'idle';
      state.trigger = persisted.trigger || null;
      state.fingerprint = persisted.fingerprint || null;
      state.manifests = Array.isArray(persisted.manifests) ? [...persisted.manifests] : [];
      state.tasks = Array.isArray(persisted.tasks) ? persisted.tasks.map(cloneTaskStatus) : [];
      state.error = persisted.error || null;
      state.updatedAt = persisted.updatedAt || null;
      state.lastRequestedAt = persisted.lastRequestedAt || null;
      state.lastAttemptAt = persisted.lastAttemptAt || null;
      state.lastPreparedAt = persisted.lastPreparedAt || null;

      if (state.state === 'queued' || state.state === 'running') {
        state.state = 'failed';
        state.error = 'Workspace prep was interrupted by a collab-server restart.';
        await persistState(state);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    } finally {
      state.loaded = true;
      state.loadingPromise = null;
    }
    return state;
  })();

  return state.loadingPromise;
}

async function planScope(slug, userId) {
  await repoCache.acquire(slug, userId);
  try {
    const repoPath = gitService.getEffectiveRepoPath(slug, userId);
    const plan = await planWorkspacePrep(repoPath);
    return { ...plan, repoPath };
  } finally {
    repoCache.release(slug, userId);
  }
}

function enqueueState(state) {
  if (!state.queueListed) {
    queue.push(state.key);
    state.queueListed = true;
  }
  scheduleRunner();
}

function scheduleRunner() {
  if (runnerScheduled) return;
  runnerScheduled = true;
  setImmediate(() => {
    runnerScheduled = false;
    while (activeRuns < MAX_PARALLEL && queue.length) {
      const key = queue.shift();
      const state = scopeStates.get(key);
      if (!state) continue;
      state.queueListed = false;
      if (!state.queuedPlan) continue;
      activeRuns += 1;
      runQueuedPlan(state)
        .catch((error) => {
          logger.error('workspace_prep_run_unhandled_failure', { slug: state.slug, userId: state.userId }, error);
        })
        .finally(() => {
          activeRuns -= 1;
          scheduleRunner();
        });
    }
  });
}

function markTaskResult(taskStatus, result) {
  taskStatus.status = result.status;
  taskStatus.message = result.message || null;
  taskStatus.missingTool = result.missingTool || null;
  taskStatus.completedAt = Date.now();
  taskStatus.durationMs = result.durationMs || null;
  taskStatus.exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
  taskStatus.signal = result.signal || null;
  taskStatus.stdoutTail = result.stdoutTail || '';
  taskStatus.stderrTail = result.stderrTail || '';
}

async function runQueuedPlan(state) {
  const plan = state.queuedPlan;
  if (!plan) return;
  state.queuedPlan = null;
  state.state = 'running';
  state.runningFingerprint = plan.fingerprint;
  state.lastAttemptAt = Date.now();
  state.tasks = plan.tasks.map((task) => ({
    id: task.id,
    ecosystem: task.ecosystem,
    rootPath: task.rootPath || '',
    manifestPaths: [...task.manifestPaths],
    commandSummary: task.commandSummary,
    status: 'pending',
    message: null,
    missingTool: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    exitCode: null,
    signal: null,
    stdoutTail: '',
    stderrTail: '',
  }));
  await persistState(state);

  logger.info('workspace_prep_started', {
    slug: state.slug,
    userId: state.userId,
    taskCount: plan.tasks.length,
    mode: getWorkspacePrepMode(),
  });

  await repoCache.acquire(state.slug, state.userId);
  try {
    for (let index = 0; index < plan.tasks.length; index += 1) {
      const task = plan.tasks[index];
      const taskStatus = state.tasks[index];
      taskStatus.status = 'running';
      taskStatus.startedAt = Date.now();
      await persistState(state);

      const result = await executeWorkspacePrepTask({
        slug: state.slug,
        userId: state.userId,
        repoPath: plan.repoPath,
        task,
      });

      markTaskResult(taskStatus, result);
      await persistState(state);

      if (result.status === 'ready') {
        continue;
      }

      state.state = result.status === 'blocked' ? 'blocked' : 'failed';
      state.error = result.message;
      break;
    }

    if (state.state === 'running') {
      state.state = 'ready';
      state.error = null;
      state.lastPreparedAt = Date.now();
    }
  } catch (error) {
    state.state = 'failed';
    state.error = error.message;
    logger.error('workspace_prep_run_failed', { slug: state.slug, userId: state.userId }, error);
  } finally {
    repoCache.release(state.slug, state.userId);
    state.runningFingerprint = null;
    await persistState(state);
  }

  logger.info('workspace_prep_finished', {
    slug: state.slug,
    userId: state.userId,
    state: state.state,
    taskCount: state.tasks.length,
  });

  if (state.pendingPlan) {
    state.queuedPlan = state.pendingPlan;
    state.pendingPlan = null;
    state.state = 'queued';
    state.trigger = state.pendingTrigger;
    state.pendingTrigger = null;
    state.pendingForce = false;
    await persistState(state);
    enqueueState(state);
  }
}

async function getWorkspacePrepStatus(slug, userId) {
  const state = getState(slug, userId);
  await loadState(state);
  return publicStatus(state);
}

async function ensureWorkspacePrepared(slug, userId, { force = false, trigger = 'workspace_load' } = {}) {
  const state = getState(slug, userId);
  await loadState(state);

  const plan = await planScope(slug, userId);
  const previousFingerprint = state.fingerprint;
  state.fingerprint = plan.fingerprint;
  state.manifests = [...plan.manifests];
  state.lastRequestedAt = Date.now();

  if (!plan.tasks.length) {
    state.state = 'ready';
    state.trigger = trigger;
    state.tasks = [];
    state.error = null;
    state.lastPreparedAt = Date.now();
    await persistState(state);
    return publicStatus(state);
  }

  const sameFingerprint = state.state === 'ready' && previousFingerprint === plan.fingerprint;
  if (!force && sameFingerprint) {
    await persistState(state);
    return publicStatus(state);
  }

  if (state.state === 'running') {
    const shouldQueueFollowUp = force || state.runningFingerprint !== plan.fingerprint;
    if (shouldQueueFollowUp) {
      state.pendingPlan = plan;
      state.pendingTrigger = trigger;
      state.pendingForce = force;
    }
    await persistState(state);
    return publicStatus(state);
  }

  state.queuedPlan = plan;
  state.trigger = trigger;
  state.state = 'queued';
  state.error = null;
  await persistState(state);
  enqueueState(state);
  return publicStatus(state);
}

module.exports = {
  ensureWorkspacePrepared,
  getWorkspacePrepStatus,
};