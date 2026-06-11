const crypto = require('crypto');
const path = require('path');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const Docker = require('dockerode');
const k8s = require('@kubernetes/client-node');
const config = require('./config');
const logger = require('./logger').child({ component: 'workspace-prep-executor' });
const spawner = require('./spawner');

const MODE = spawner.mode;
const TOOL_MISSING_MARKER = '__SYNTHI_PREP_TOOL_MISSING__:';
const OUTPUT_TAIL_LIMIT = 24 * 1024;

const DOCKER_SOCKET = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const WORKER_IMAGE = process.env.WORKER_IMAGE || 'synthi-worker:local';
const WORKER_NETWORK = process.env.WORKER_NETWORK || 'synthi-ide_default';
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'synthi';
const WORKSPACE_NODE_SELECTOR_KEY = (process.env.WORKSPACE_NODE_SELECTOR_KEY || 'cloud.google.com/gke-nodepool').trim();
const WORKSPACE_NODE_SELECTOR_VALUE = (process.env.WORKSPACE_NODE_SELECTOR_VALUE || 'workspace-pool').trim();
const WORKSPACE_NODE_TAINT_KEY = (process.env.WORKSPACE_NODE_TAINT_KEY || 'workload').trim();
const WORKSPACE_NODE_TAINT_VALUE = (process.env.WORKSPACE_NODE_TAINT_VALUE || 'workspace').trim();
const WORKSPACE_NODE_TAINT_EFFECT = (process.env.WORKSPACE_NODE_TAINT_EFFECT || 'NoSchedule').trim();

let dockerClient = null;
let k8sClients = null;

function appendTail(current, chunk) {
  const next = `${current}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)}`;
  return next.length > OUTPUT_TAIL_LIMIT ? next.slice(-OUTPUT_TAIL_LIMIT) : next;
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizePosixPath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function safeName(value, prefix = 'prep') {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) return `${prefix}-${Date.now().toString(36)}`;
  return `${prefix}-${normalized}`.slice(0, 52);
}

function buildWorkspaceScheduling() {
  const nodeSelector = WORKSPACE_NODE_SELECTOR_KEY && WORKSPACE_NODE_SELECTOR_VALUE
    ? { [WORKSPACE_NODE_SELECTOR_KEY]: WORKSPACE_NODE_SELECTOR_VALUE }
    : undefined;

  const tolerations = WORKSPACE_NODE_TAINT_KEY && WORKSPACE_NODE_TAINT_VALUE
    ? [{
        key: WORKSPACE_NODE_TAINT_KEY,
        operator: 'Equal',
        value: WORKSPACE_NODE_TAINT_VALUE,
        effect: WORKSPACE_NODE_TAINT_EFFECT,
      }]
    : [];

  return { nodeSelector, tolerations };
}

function commonRuntimeEnv() {
  return {
    CI: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PYTHONUNBUFFERED: '1',
  };
}

function environmentEntries(extra = {}) {
  return Object.entries({ ...commonRuntimeEnv(), ...extra }).map(([key, value]) => `${key}=${value}`);
}

function mapRepoPathToRuntimeMount(repoPath) {
  const normalizedRepoPath = normalizePosixPath(repoPath);
  const normalizedReposDir = normalizePosixPath(config.REPOS_DIR);
  const repoRootParent = path.posix.dirname(normalizedReposDir);
  const relativeFromParent = path.posix.relative(repoRootParent, normalizedRepoPath);
  if (!relativeFromParent || relativeFromParent.startsWith('..')) {
    throw new Error(`Cannot map repo path ${repoPath} into workspace prep mount ${config.WORKSPACE_PREP_MOUNT_PATH}`);
  }
  return path.posix.join(config.WORKSPACE_PREP_MOUNT_PATH, relativeFromParent);
}

function runtimeContextForTask(repoPath, task) {
  const taskSegments = String(task.rootPath || '').split('/').filter(Boolean);
  if (MODE === 'process') {
    const isWindows = process.platform === 'win32';
    return {
      mode: MODE,
      platform: isWindows ? 'windows' : 'linux',
      repoPath,
      taskCwd: taskSegments.length ? path.join(repoPath, ...taskSegments) : repoPath,
    };
  }

  const runtimeRepoPath = mapRepoPathToRuntimeMount(repoPath);
  return {
    mode: MODE,
    platform: 'linux',
    repoPath,
    taskCwd: taskSegments.length ? path.posix.join(runtimeRepoPath, ...taskSegments) : runtimeRepoPath,
  };
}

function renderToolCheck(toolName, runtime) {
  if (!toolName) return '';
  if (runtime.platform === 'windows') {
    return `if (-not (Get-Command ${toolName} -ErrorAction SilentlyContinue)) { Write-Error \"${TOOL_MISSING_MARKER}${toolName}\"; exit 127 }`;
  }
  return `command -v ${toolName} >/dev/null 2>&1 || { echo \"${TOOL_MISSING_MARKER}${toolName}\" >&2; exit 127; }`;
}

function renderTaskRecipe(task, runtime) {
  switch (task.ecosystem) {
    case 'node': {
      const packageManager = task.packageManager || 'npm';
      if (packageManager === 'pnpm') {
        return {
          checkTool: 'corepack',
          displayCommand: task.commandSummary,
          lines: [task.commandSummary],
        };
      }
      if (packageManager === 'yarn') {
        return {
          checkTool: 'corepack',
          displayCommand: 'corepack yarn install',
          lines: ['corepack yarn install'],
        };
      }
      return {
        checkTool: 'npm',
        displayCommand: task.commandSummary,
        lines: [task.commandSummary],
      };
    }
    case 'python': {
      if (runtime.platform === 'windows') {
        const lines = [
          renderToolCheck('python', runtime),
          'if (-not (Test-Path ".venv")) { python -m venv .venv }',
          '.\\.venv\\Scripts\\python -m pip install --upgrade pip',
        ];
        if (task.requirementsFile) {
          lines.push(`.\\.venv\\Scripts\\python -m pip install -r ${psQuote(task.requirementsFile)}`);
        }
        if (task.editableInstall) {
          lines.push('.\\.venv\\Scripts\\python -m pip install -e .');
        }
        return {
          checkTool: null,
          displayCommand: task.commandSummary,
          lines,
        };
      }

      const lines = [
        renderToolCheck('python3', runtime),
        'if [ ! -d .venv ]; then python3 -m venv .venv; fi',
        '. .venv/bin/activate',
        'python -m pip install --upgrade pip',
      ];
      if (task.requirementsFile) {
        lines.push(`python -m pip install -r ${shQuote(task.requirementsFile)}`);
      }
      if (task.editableInstall) {
        lines.push('python -m pip install -e .');
      }
      return {
        checkTool: null,
        displayCommand: task.commandSummary,
        lines,
      };
    }
    case 'rust':
      return {
        checkTool: 'cargo',
        displayCommand: task.commandSummary,
        lines: [task.commandSummary],
      };
    case 'maven': {
      const wrapper = task.wrapper;
      if (runtime.platform === 'windows') {
        const command = wrapper === 'mvnw' || wrapper === 'mvnw.cmd'
          ? `.\\${wrapper} -q -DskipTests dependency:go-offline`
          : 'mvn -q -DskipTests dependency:go-offline';
        return {
          checkTool: wrapper ? null : 'mvn',
          displayCommand: command,
          lines: [renderToolCheck(wrapper ? null : 'mvn', runtime), command].filter(Boolean),
        };
      }
      const useWrapper = wrapper === 'mvnw';
      const command = useWrapper ? './mvnw -q -DskipTests dependency:go-offline' : 'mvn -q -DskipTests dependency:go-offline';
      const lines = [];
      if (!useWrapper) lines.push(renderToolCheck('mvn', runtime));
      if (useWrapper) lines.push('chmod +x ./mvnw');
      lines.push(command);
      return { checkTool: null, displayCommand: command, lines };
    }
    case 'gradle': {
      const wrapper = task.wrapper;
      if (runtime.platform === 'windows') {
        const command = wrapper === 'gradlew' || wrapper === 'gradlew.bat'
          ? `.\\${wrapper} --no-daemon dependencies`
          : 'gradle --no-daemon dependencies';
        return {
          checkTool: wrapper ? null : 'gradle',
          displayCommand: command,
          lines: [renderToolCheck(wrapper ? null : 'gradle', runtime), command].filter(Boolean),
        };
      }
      const useWrapper = wrapper === 'gradlew';
      const command = useWrapper ? './gradlew --no-daemon dependencies' : 'gradle --no-daemon dependencies';
      const lines = [];
      if (!useWrapper) lines.push(renderToolCheck('gradle', runtime));
      if (useWrapper) lines.push('chmod +x ./gradlew');
      lines.push(command);
      return { checkTool: null, displayCommand: command, lines };
    }
    case 'dart': {
      const toolName = task.isFlutter ? 'flutter' : 'dart';
      return {
        checkTool: toolName,
        displayCommand: task.commandSummary,
        lines: [task.commandSummary],
      };
    }
    default:
      throw new Error(`Unsupported workspace prep ecosystem: ${task.ecosystem}`);
  }
}

function renderShellScript(task, runtime) {
  const recipe = renderTaskRecipe(task, runtime);
  if (runtime.platform === 'windows') {
    const lines = recipe.lines.filter(Boolean);
    return {
      displayCommand: recipe.displayCommand,
      shellCommand: lines.join('\n'),
    };
  }

  const lines = [
    'set -euo pipefail',
    'export PATH="/usr/local/cargo/bin:/usr/local/bin:${PATH}"',
  ];
  if (recipe.checkTool) lines.push(renderToolCheck(recipe.checkTool, runtime));
  lines.push(...recipe.lines.filter(Boolean));
  return {
    displayCommand: recipe.displayCommand,
    shellCommand: lines.join('\n'),
  };
}

function parseExecutionOutcome(task, rawResult) {
  const output = [rawResult.stderrTail, rawResult.stdoutTail].filter(Boolean).join('\n');
  const missingToolMatch = output.match(/__SYNTHI_PREP_TOOL_MISSING__:(\S+)/);
  if (missingToolMatch) {
    return {
      status: 'blocked',
      message: `${task.ecosystem} prep is blocked because ${missingToolMatch[1]} is unavailable in ${MODE} mode.`,
      missingTool: missingToolMatch[1],
      exitCode: rawResult.exitCode,
      signal: rawResult.signal || null,
      durationMs: rawResult.durationMs,
      stdoutTail: rawResult.stdoutTail,
      stderrTail: rawResult.stderrTail,
    };
  }

  if (rawResult.timedOut) {
    return {
      status: 'failed',
      message: `${task.ecosystem} prep timed out after ${Math.round(rawResult.durationMs / 1000)}s.`,
      exitCode: rawResult.exitCode,
      signal: rawResult.signal || null,
      durationMs: rawResult.durationMs,
      stdoutTail: rawResult.stdoutTail,
      stderrTail: rawResult.stderrTail,
    };
  }

  if (rawResult.exitCode === 0) {
    return {
      status: 'ready',
      message: `${task.ecosystem} prep completed successfully.`,
      exitCode: 0,
      signal: rawResult.signal || null,
      durationMs: rawResult.durationMs,
      stdoutTail: rawResult.stdoutTail,
      stderrTail: rawResult.stderrTail,
    };
  }

  return {
    status: 'failed',
    message: `${task.ecosystem} prep failed with exit code ${rawResult.exitCode == null ? 'unknown' : rawResult.exitCode}.`,
    exitCode: rawResult.exitCode,
    signal: rawResult.signal || null,
    durationMs: rawResult.durationMs,
    stdoutTail: rawResult.stdoutTail,
    stderrTail: rawResult.stderrTail,
  };
}

function getDockerClient() {
  if (!dockerClient) {
    dockerClient = new Docker({ socketPath: DOCKER_SOCKET });
  }
  return dockerClient;
}

function getK8sClients() {
  if (k8sClients) return k8sClients;
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    kc.loadFromDefault();
  }
  k8sClients = {
    batchApi: kc.makeApiClient(k8s.BatchV1Api),
    coreApi: kc.makeApiClient(k8s.CoreV1Api),
  };
  return k8sClients;
}

async function runProcessTask(task, runtime, shellCommand, timeoutMs) {
  const start = Date.now();
  const isWindows = runtime.platform === 'windows';
  const shell = isWindows ? 'powershell.exe' : '/bin/bash';
  const args = isWindows
    ? ['-NoLogo', '-NoProfile', '-Command', shellCommand]
    : ['-lc', shellCommand];

  return await new Promise((resolve, reject) => {
    const child = spawn(shell, args, {
      cwd: runtime.taskCwd,
      env: { ...process.env, ...commonRuntimeEnv() },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutTail = '';
    let stderrTail = '';
    let timedOut = false;
    let timeoutHandle = null;

    child.stdout.on('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk);
    });

    child.on('error', reject);

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill(isWindows ? undefined : 'SIGTERM');
        } catch (_) {
          // Ignore kill failures.
        }
      }, timeoutMs);
    }

    child.on('close', (exitCode, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve({
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdoutTail,
        stderrTail,
        timedOut,
      });
    });
  });
}

async function pullWorkerImageIfNeeded(docker, imageName) {
  await new Promise((resolve, reject) => {
    docker.pull(imageName, (pullError, stream) => {
      if (pullError) return reject(pullError);
      docker.modem.followProgress(stream, (followError) => {
        if (followError) reject(followError);
        else resolve();
      });
    });
  });
}

async function runLocalContainerTask(task, runtime, shellCommand, timeoutMs, scope) {
  const docker = getDockerClient();
  const start = Date.now();
  const containerName = safeName(`${scope.slug}-${scope.userId || 'shared'}-${task.id}-${Date.now().toString(36)}`, 'workspace-prep');
  let container = null;
  let stdoutTail = '';
  let stderrTail = '';
  let timedOut = false;

  try {
    try {
      container = await docker.createContainer({
        name: containerName,
        Image: WORKER_IMAGE,
        Entrypoint: ['/bin/bash', '-lc'],
        Cmd: [shellCommand],
        WorkingDir: runtime.taskCwd,
        Env: environmentEntries(),
        Labels: {
          'app.kubernetes.io/managed-by': 'workspace-prep-local',
          'synthi/workspace': scope.slug,
          'synthi/user': String(scope.userId || ''),
          'synthi/task': task.id,
        },
        HostConfig: {
          AutoRemove: false,
          NetworkMode: WORKER_NETWORK,
          Mounts: [{
            Type: 'volume',
            Source: config.WORKSPACE_PREP_LOCAL_VOLUME,
            Target: config.WORKSPACE_PREP_MOUNT_PATH,
          }],
        },
      });
    } catch (error) {
      if (error.statusCode === 404 && /No such image/i.test(error.message || '')) {
        logger.info('workspace_prep_pull_worker_image', { image: WORKER_IMAGE });
        await pullWorkerImageIfNeeded(docker, WORKER_IMAGE);
        container = await docker.createContainer({
          name: containerName,
          Image: WORKER_IMAGE,
          Entrypoint: ['/bin/bash', '-lc'],
          Cmd: [shellCommand],
          WorkingDir: runtime.taskCwd,
          Env: environmentEntries(),
          Labels: {
            'app.kubernetes.io/managed-by': 'workspace-prep-local',
            'synthi/workspace': scope.slug,
            'synthi/user': String(scope.userId || ''),
            'synthi/task': task.id,
          },
          HostConfig: {
            AutoRemove: false,
            NetworkMode: WORKER_NETWORK,
            Mounts: [{
              Type: 'volume',
              Source: config.WORKSPACE_PREP_LOCAL_VOLUME,
              Target: config.WORKSPACE_PREP_MOUNT_PATH,
            }],
          },
        });
      } else {
        throw error;
      }
    }

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    stdoutStream.on('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk);
    });
    stderrStream.on('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk);
    });

    const attached = await container.attach({ stream: true, stdout: true, stderr: true });
    docker.modem.demuxStream(attached, stdoutStream, stderrStream);

    await container.start();

    let timeoutHandle = null;
    const waitPromise = container.wait();
    const result = await Promise.race([
      waitPromise,
      new Promise((resolve) => {
        timeoutHandle = setTimeout(async () => {
          timedOut = true;
          try {
            await container.stop({ t: 5 });
          } catch (_) {
            // Ignore stop failures.
          }
          resolve({ StatusCode: 124 });
        }, timeoutMs);
      }),
    ]);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    return {
      exitCode: typeof result.StatusCode === 'number' ? result.StatusCode : null,
      signal: null,
      durationMs: Date.now() - start,
      stdoutTail,
      stderrTail,
      timedOut,
    };
  } finally {
    if (container) {
      try {
        await container.remove({ force: true });
      } catch (_) {
        // Ignore cleanup failures.
      }
    }
  }
}

async function listJobPods(coreApi, jobName) {
  try {
    const { body } = await coreApi.listNamespacedPod(
      K8S_NAMESPACE,
      undefined,
      undefined,
      undefined,
      undefined,
      `job-name=${jobName}`,
    );
    return Array.isArray(body?.items) ? body.items : [];
  } catch (_) {
    return [];
  }
}

async function readPodLogs(coreApi, podName) {
  if (!podName) return '';
  try {
    const { body } = await coreApi.readNamespacedPodLog(podName, K8S_NAMESPACE, 'prep');
    return typeof body === 'string' ? body : '';
  } catch (_) {
    return '';
  }
}

async function runK8sJobTask(task, runtime, shellCommand, timeoutMs, scope) {
  const { batchApi, coreApi } = getK8sClients();
  const start = Date.now();
  const scheduling = buildWorkspaceScheduling();
  const jobName = safeName(`${scope.slug}-${crypto.createHash('sha1').update(`${scope.userId || 'shared'}:${task.id}:${Date.now()}`).digest('hex').slice(0, 8)}`, 'prep');

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: K8S_NAMESPACE,
      labels: {
        app: 'workspace-prep',
        'app.kubernetes.io/managed-by': 'workspace-prep',
        'synthi/workspace': scope.slug,
        'synthi/user': String(scope.userId || ''),
        'synthi/task': task.id,
      },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: {
          labels: {
            app: 'workspace-prep',
            'synthi/workspace': scope.slug,
            'synthi/task': task.id,
          },
        },
        spec: {
          restartPolicy: 'Never',
          securityContext: {
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          ...(scheduling.nodeSelector ? { nodeSelector: scheduling.nodeSelector } : {}),
          ...(scheduling.tolerations.length ? { tolerations: scheduling.tolerations } : {}),
          containers: [{
            name: 'prep',
            image: WORKER_IMAGE,
            securityContext: {
              runAsUser: 0,
              runAsGroup: 0,
              allowPrivilegeEscalation: true,
            },
            command: ['/bin/bash', '-lc', shellCommand],
            workingDir: runtime.taskCwd,
            env: Object.entries(commonRuntimeEnv()).map(([name, value]) => ({ name, value })),
            volumeMounts: [{
              name: 'collab-data',
              mountPath: config.WORKSPACE_PREP_MOUNT_PATH,
            }],
          }],
          volumes: [{
            name: 'collab-data',
            persistentVolumeClaim: { claimName: config.WORKSPACE_PREP_PVC_NAME },
          }],
        },
      },
    },
  };

  await batchApi.createNamespacedJob(K8S_NAMESPACE, job);

  let timedOut = false;
  let statusCode = null;
  try {
    while ((Date.now() - start) < timeoutMs) {
      const { body } = await batchApi.readNamespacedJobStatus(jobName, K8S_NAMESPACE);
      const succeeded = Number(body?.status?.succeeded || 0);
      const failed = Number(body?.status?.failed || 0);
      if (succeeded > 0) {
        statusCode = 0;
        break;
      }
      if (failed > 0) {
        statusCode = 1;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (statusCode == null) {
      timedOut = true;
      statusCode = 124;
    }

    const pods = await listJobPods(coreApi, jobName);
    const podName = pods[0]?.metadata?.name || null;
    const combinedLogs = await readPodLogs(coreApi, podName);

    return {
      exitCode: statusCode,
      signal: null,
      durationMs: Date.now() - start,
      stdoutTail: statusCode === 0 ? appendTail('', combinedLogs) : '',
      stderrTail: statusCode === 0 ? '' : appendTail('', combinedLogs),
      timedOut,
    };
  } finally {
    if (timedOut) {
      try {
        await batchApi.deleteNamespacedJob(jobName, K8S_NAMESPACE);
      } catch (_) {
        // Ignore timeout cleanup failures.
      }
    }
  }
}

async function executeWorkspacePrepTask({ slug, userId, repoPath, task }) {
  const runtime = runtimeContextForTask(repoPath, task);
  const { shellCommand } = renderShellScript(task, runtime);
  const timeoutMs = Number(task.timeoutMs) || config.WORKSPACE_PREP_JOB_TIMEOUT_MS;

  logger.info('workspace_prep_task_dispatch', {
    slug,
    userId: userId || null,
    taskId: task.id,
    ecosystem: task.ecosystem,
    mode: MODE,
    cwd: runtime.taskCwd,
  });

  let rawResult;
  if (MODE === 'process') {
    rawResult = await runProcessTask(task, runtime, shellCommand, timeoutMs);
  } else if (MODE === 'local') {
    rawResult = await runLocalContainerTask(task, runtime, shellCommand, timeoutMs, { slug, userId });
  } else if (MODE === 'k8s') {
    rawResult = await runK8sJobTask(task, runtime, shellCommand, timeoutMs, { slug, userId });
  } else {
    throw new Error(`Unsupported workspace prep mode: ${MODE}`);
  }

  return parseExecutionOutcome(task, rawResult);
}

module.exports = {
  executeWorkspacePrepTask,
  getWorkspacePrepMode: () => MODE,
};
