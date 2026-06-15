'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPersistentRuntimeEnv,
  persistentRuntimePaths,
  persistentRuntimeShellSetup,
} = require('./runtimePersistence');

test('builds hidden persistent runtime home under the workspace directory', () => {
  const env = buildPersistentRuntimeEnv('/data/repos/demo/user-a');

  assert.equal(env.HOME, '/data/repos/demo/user-a/.synthi/runtime/home');
  assert.equal(env.XDG_CONFIG_HOME, '/data/repos/demo/user-a/.synthi/runtime/config');
  assert.equal(env.XDG_CACHE_HOME, '/data/repos/demo/user-a/.synthi/runtime/cache');
  assert.equal(env.NPM_CONFIG_PREFIX, '/data/repos/demo/user-a/.synthi/runtime/data/npm-global');
  assert.equal(env.CARGO_INSTALL_ROOT, '/data/repos/demo/user-a/.synthi/runtime/data/cargo');
  assert.equal(env.CARGO_HOME, undefined);
  assert.equal(env.RUSTUP_HOME, undefined);
  assert.match(env.SYNTHI_PERSISTENT_PATH_PREFIX, /npm-global\/bin/);
  assert.match(env.SYNTHI_PERSISTENT_PATH_PREFIX, /cargo\/bin/);
});

test('uses Windows path syntax when the workspace path is Windows-shaped', () => {
  const paths = persistentRuntimePaths('C:\\workspaces\\demo\\user-a');
  const env = buildPersistentRuntimeEnv('C:\\workspaces\\demo\\user-a');

  assert.equal(paths.home, 'C:\\workspaces\\demo\\user-a\\.synthi\\runtime\\home');
  assert.ok(env.SYNTHI_PERSISTENT_PATH_PREFIX.includes(';'));
  assert.ok(env.NPM_CONFIG_PREFIX.endsWith('\\data\\npm-global'));
});

test('shell setup creates runtime directories and prepends persistent bins', () => {
  const setup = persistentRuntimeShellSetup();

  assert.match(setup, /mkdir -p/);
  assert.match(setup, /SYNTHI_PERSISTENT_PATH_PREFIX/);
  assert.match(setup, /export PATH=/);
});
