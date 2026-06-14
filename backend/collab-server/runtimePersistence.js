'use strict';

const fs = require('fs');
const path = require('path');

function normalizeWorkspaceDir(workspaceDir) {
  const raw = String(workspaceDir || '').trim();
  if (!raw) return '';
  return raw.replace(/[\\/]+$/, '');
}

function isWindowsPath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '')) || String(value || '').includes('\\');
}

function pathApiFor(value) {
  return isWindowsPath(value) ? path.win32 : path.posix;
}

function joinRuntimePath(base, ...parts) {
  const api = pathApiFor(base);
  return api.join(base, ...parts);
}

function pathDelimiterFor(value) {
  return isWindowsPath(value) ? ';' : ':';
}

function persistentRuntimePaths(workspaceDir) {
  const rootWorkspaceDir = normalizeWorkspaceDir(workspaceDir);
  if (!rootWorkspaceDir) return null;

  const runtimeRoot = joinRuntimePath(rootWorkspaceDir, '.synthi', 'runtime');
  const home = joinRuntimePath(runtimeRoot, 'home');
  const config = joinRuntimePath(runtimeRoot, 'config');
  const cache = joinRuntimePath(runtimeRoot, 'cache');
  const data = joinRuntimePath(runtimeRoot, 'data');
  const state = joinRuntimePath(runtimeRoot, 'state');

  return {
    rootWorkspaceDir,
    runtimeRoot,
    home,
    config,
    cache,
    data,
    state,
    npmGlobal: joinRuntimePath(data, 'npm-global'),
    pnpmHome: joinRuntimePath(data, 'pnpm'),
    bunHome: joinRuntimePath(data, 'bun'),
    cargoHome: joinRuntimePath(data, 'cargo'),
    rustupHome: joinRuntimePath(data, 'rustup'),
    goPath: joinRuntimePath(data, 'go'),
  };
}

function buildPersistentRuntimeEnv(workspaceDir) {
  const paths = persistentRuntimePaths(workspaceDir);
  if (!paths) return {};

  const prefixEntries = [
    joinRuntimePath(paths.npmGlobal, 'bin'),
    paths.pnpmHome,
    joinRuntimePath(paths.bunHome, 'bin'),
    joinRuntimePath(paths.cargoHome, 'bin'),
    joinRuntimePath(paths.home, '.local', 'bin'),
    joinRuntimePath(paths.goPath, 'bin'),
  ];

  return {
    SYNTHI_PERSISTENT_RUNTIME_ROOT: paths.runtimeRoot,
    SYNTHI_PERSISTENT_HOME: paths.home,
    SYNTHI_PERSISTENT_PATH_PREFIX: prefixEntries.join(pathDelimiterFor(paths.rootWorkspaceDir)),

    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,

    GIT_CONFIG_GLOBAL: joinRuntimePath(paths.home, '.gitconfig'),
    NPM_CONFIG_USERCONFIG: joinRuntimePath(paths.home, '.npmrc'),
    NPM_CONFIG_CACHE: joinRuntimePath(paths.cache, 'npm'),
    NPM_CONFIG_PREFIX: paths.npmGlobal,
    npm_config_userconfig: joinRuntimePath(paths.home, '.npmrc'),
    npm_config_cache: joinRuntimePath(paths.cache, 'npm'),
    npm_config_prefix: paths.npmGlobal,

    PNPM_HOME: paths.pnpmHome,
    COREPACK_HOME: joinRuntimePath(paths.cache, 'corepack'),
    YARN_CACHE_FOLDER: joinRuntimePath(paths.cache, 'yarn'),
    BUN_INSTALL: paths.bunHome,

    CARGO_HOME: paths.cargoHome,
    RUSTUP_HOME: paths.rustupHome,

    PIP_CACHE_DIR: joinRuntimePath(paths.cache, 'pip'),
    POETRY_CONFIG_DIR: joinRuntimePath(paths.config, 'pypoetry'),
    POETRY_CACHE_DIR: joinRuntimePath(paths.cache, 'pypoetry'),
    PDM_HOME: joinRuntimePath(paths.data, 'pdm'),
    UV_CACHE_DIR: joinRuntimePath(paths.cache, 'uv'),

    GOPATH: paths.goPath,
    GOMODCACHE: joinRuntimePath(paths.goPath, 'pkg', 'mod'),
    GOCACHE: joinRuntimePath(paths.cache, 'go-build'),
  };
}

function persistentRuntimeEnvEntries(workspaceDir) {
  return Object.entries(buildPersistentRuntimeEnv(workspaceDir))
    .filter(([key, value]) => key && value)
    .map(([name, value]) => ({ name, value }));
}

function persistentRuntimeDirectoryEnvNames() {
  return [
    'SYNTHI_PERSISTENT_RUNTIME_ROOT',
    'HOME',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'NPM_CONFIG_CACHE',
    'NPM_CONFIG_PREFIX',
    'PNPM_HOME',
    'COREPACK_HOME',
    'YARN_CACHE_FOLDER',
    'BUN_INSTALL',
    'CARGO_HOME',
    'RUSTUP_HOME',
    'PIP_CACHE_DIR',
    'POETRY_CONFIG_DIR',
    'POETRY_CACHE_DIR',
    'PDM_HOME',
    'UV_CACHE_DIR',
    'GOPATH',
    'GOMODCACHE',
    'GOCACHE',
  ];
}

function persistentRuntimeShellSetup() {
  const names = persistentRuntimeDirectoryEnvNames().join(' ');
  return [
    `for __synthi_dir_var in ${names}; do`,
    '  eval "__synthi_dir=\\${$__synthi_dir_var:-}"',
    '  [ -n "$__synthi_dir" ] && mkdir -p "$__synthi_dir" 2>/dev/null || true',
    'done',
    'if [ -n "${SYNTHI_PERSISTENT_PATH_PREFIX:-}" ]; then',
    '  export PATH="${SYNTHI_PERSISTENT_PATH_PREFIX}:${PATH}"',
    'fi',
    'unset __synthi_dir __synthi_dir_var',
  ].join('\n');
}

function ensurePersistentRuntimeDirs(workspaceDir) {
  const env = buildPersistentRuntimeEnv(workspaceDir);
  for (const key of persistentRuntimeDirectoryEnvNames()) {
    const dir = env[key];
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn(`[RuntimePersistence] Failed to create ${key}=${dir}: ${err.message}`);
    }
  }
  return env;
}

module.exports = {
  buildPersistentRuntimeEnv,
  ensurePersistentRuntimeDirs,
  persistentRuntimeEnvEntries,
  persistentRuntimePaths,
  persistentRuntimeShellSetup,
};
