/**
 * @fileoverview Pure import mapper for a documented subset of the
 * devcontainer `devcontainer.json` standard → the same NormalizedProgramConfig
 * shape produced by `manifest.js`.
 *
 * Phase 2 treats a devcontainer as a *recipe of managed commands*, not a
 * container runtime: `image`/`build` are recorded as informational hints only.
 * Host-escaping keys (host bind mounts, docker.sock, --privileged runArgs,
 * host-access features) are rejected. Declared env that matches the platform
 * denylist is stripped (defense-in-depth + user transparency); the authoritative
 * scrub still happens in the collab-server runtime manager at launch time.
 */

import { coerceManifestObject, parseProgramManifest, ProgramManifestError, normalizeWorkingDir } from './manifest';

/** Env key prefixes mirrored from the runtime scrub denylist (transparency only). */
const BLOCKED_ENV_PREFIXES = [
  'DATABASE', 'POSTGRES', 'REDIS', 'PRISMA',
  'GOOGLE', 'GCS', 'GCP', 'KUBERNETES', 'K8S', 'KUBECONFIG',
  'DOCKER_HOST', 'DOCKER_SOCKET', 'DOCKER_CERT', 'DOCKER_TLS',
  'NEXTAUTH', 'AUTH_', 'YSWEET', 'SYNTHI_',
];

function isBlockedEnvKey(key) {
  const u = String(key).toUpperCase();
  return BLOCKED_ENV_PREFIXES.some((p) => u === p || u.startsWith(p));
}

/**
 * Flatten a devcontainer lifecycle command (string | argv array | object map)
 * into an array of shell command strings.
 */
function flattenCommand(cmd) {
  if (cmd == null) return [];
  if (typeof cmd === 'string') return cmd.trim() ? [cmd.trim()] : [];
  if (Array.isArray(cmd)) {
    const joined = cmd.filter((c) => typeof c === 'string').join(' ').trim();
    return joined ? [joined] : [];
  }
  if (typeof cmd === 'object') {
    const out = [];
    for (const v of Object.values(cmd)) out.push(...flattenCommand(v));
    return out;
  }
  return [];
}

/** Minimal POSIX shell quoting: single-quote wrap, escape embedded single quotes. */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function slugifyPackageId(name) {
  const base = typeof name === 'string' && name.trim() ? name.trim() : 'devcontainer';
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = 'devcontainer';
  return slug;
}

/** Reject any devcontainer key that would escape the workspace boundary. */
function assertNoHostEscape(dc) {
  if (dc.privileged === true) {
    throw new ProgramManifestError('host_escape', 'privileged containers are not allowed', 'privileged');
  }

  if (dc.mounts != null) {
    const mounts = Array.isArray(dc.mounts) ? dc.mounts : [dc.mounts];
    for (const m of mounts) {
      const s = typeof m === 'string' ? m : JSON.stringify(m || {});
      if (/docker\.sock/i.test(s) || /type=bind/i.test(s) || /source=\//i.test(s) || /\/var\/run/i.test(s)) {
        throw new ProgramManifestError('host_escape', 'host bind mounts are not allowed', 'mounts');
      }
    }
  }

  if (Array.isArray(dc.runArgs)) {
    const joined = dc.runArgs.join(' ');
    if (/--privileged|--security-opt|docker\.sock|(^|\s)-v(\s|$)|--device|--cap-add/i.test(joined)) {
      throw new ProgramManifestError('host_escape', 'runArgs request host access', 'runArgs');
    }
  }

  const features = dc.features && typeof dc.features === 'object' ? Object.keys(dc.features) : [];
  if (features.some((f) => /docker-in-docker|docker-outside-of-docker|sshd/i.test(f))) {
    throw new ProgramManifestError('host_escape', 'host-access features are not allowed', 'features');
  }
}

/**
 * Import a devcontainer.json into a NormalizedProgramConfig.
 *
 * @param {object|string} input - devcontainer object or JSON text
 * @param {{ containerRuntime?: boolean }} [options]
 * @returns {{ config: import('./manifest').NormalizedProgramConfig, strippedEnvKeys: string[], warnings: string[] }}
 * @throws {ProgramManifestError}
 */
export function importDevcontainer(input, { containerRuntime = false } = {}) {
  const dc = coerceManifestObject(input);
  assertNoHostEscape(dc);

  const warnings = [];

  // env: merge containerEnv + remoteEnv, strip blocked platform keys.
  const rawEnv = {
    ...(dc.containerEnv && typeof dc.containerEnv === 'object' && !Array.isArray(dc.containerEnv) ? dc.containerEnv : {}),
    ...(dc.remoteEnv && typeof dc.remoteEnv === 'object' && !Array.isArray(dc.remoteEnv) ? dc.remoteEnv : {}),
  };
  const strippedEnvKeys = [];
  const env = {};
  for (const [k, v] of Object.entries(rawEnv)) {
    if (typeof k !== 'string' || !k) continue;
    if (isBlockedEnvKey(k)) {
      strippedEnvKeys.push(k);
      continue;
    }
    if (typeof v === 'string') env[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') env[k] = String(v);
  }

  // ports: forwardPorts → declared web ports (accept "host:container" string form).
  const forwardPorts = Array.isArray(dc.forwardPorts) ? dc.forwardPorts : [];
  const ports = [];
  for (const p of forwardPorts) {
    const n = typeof p === 'number' ? p : parseInt(String(p).split(':').pop(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535 && !ports.includes(n)) ports.push(n);
  }

  const image = typeof dc.image === 'string' && dc.image.trim() ? dc.image.trim() : null;
  // A devcontainer dockerfile is a workspace-relative path; run it through the
  // shared normalizer so absolute paths / `..` traversal are rejected (throws).
  const rawDockerfile = (dc.build && typeof dc.build.dockerfile === 'string') ? dc.build.dockerfile
    : (typeof dc.dockerFile === 'string' ? dc.dockerFile : null);
  const dockerfile = rawDockerfile ? (normalizeWorkingDir(rawDockerfile, 'dockerfile') || null) : null;

  let runtimeType, install, launch;
  const portFlags = ports.map((p) => `-p ${p}:${p}`).join(' ');
  if (containerRuntime && (image || dockerfile)) {
    runtimeType = 'container';
    const tag = image || `${slugifyPackageId(dc.name)}:local`;
    const inContainerCmd = [
      ...flattenCommand(dc.onCreateCommand),
      ...flattenCommand(dc.updateContentCommand),
      ...flattenCommand(dc.postCreateCommand),
      ...flattenCommand(dc.postStartCommand),
    ].join(' && ') || 'sleep infinity';
    // Shell-quote user-controlled image/tag/dockerfile so a recipe value like
    // `node:20; rm -rf /` cannot break out into a separate command. The sh -lc
    // argument is safely encoded via JSON.stringify (one double-quoted arg).
    const portFragment = portFlags ? `${portFlags} ` : '';
    install = image
      ? [`docker pull ${shellQuote(image)}`]
      : [`docker build -t ${shellQuote(tag)} -f ${shellQuote(dockerfile)} .`];
    launch = `docker run --rm ${portFragment}-v "$PWD":/workspace -w /workspace ${shellQuote(tag)} sh -lc ${JSON.stringify(inContainerCmd)}`;
  } else {
    // install: onCreate → updateContent → postCreate, in order.
    install = [
      ...flattenCommand(dc.onCreateCommand),
      ...flattenCommand(dc.updateContentCommand),
      ...flattenCommand(dc.postCreateCommand),
    ];

    // launch: postStartCommand, else a keep-alive so the session stays observable.
    const launchCmds = flattenCommand(dc.postStartCommand);
    launch = launchCmds.length ? launchCmds.join(' && ') : 'sleep infinity';

    runtimeType = ports.length ? 'web' : 'background';
  }

  // workspaceFolder is a container path, not a host-workspace-relative one — ignore it.
  if (dc.workspaceFolder != null) warnings.push('ignored:workspaceFolder');

  const packageId = slugifyPackageId(dc.name);
  const displayName = typeof dc.name === 'string' && dc.name.trim() ? dc.name.trim() : packageId;

  const sourceHints = {};
  if (typeof dc.image === 'string' && dc.image.trim()) sourceHints.containerImage = dc.image.trim();
  if (dc.build && typeof dc.build === 'object' && typeof dc.build.dockerfile === 'string') {
    sourceHints.containerBuild = dc.build.dockerfile;
  } else if (typeof dc.dockerFile === 'string') {
    sourceHints.containerBuild = dc.dockerFile;
  }

  // devcontainers don't declare Synthi scopes; imply launch (+ network/ports when web).
  const permissions = ['program.launch'];
  if (ports.length) permissions.push('ports.expose', 'network.outbound');

  // Run through the canonical normalizer so every invariant matches manifest.js.
  const config = parseProgramManifest({
    packageId,
    version: typeof dc.version === 'string' && dc.version.trim() ? dc.version : '0.0.0',
    displayName,
    runtimeType,
    workingDir: '',
    install,
    launch,
    env,
    ports,
    permissions,
  });
  config.source = 'devcontainer.json';
  config.sourceHints = sourceHints;

  return { config, strippedEnvKeys, warnings };
}
