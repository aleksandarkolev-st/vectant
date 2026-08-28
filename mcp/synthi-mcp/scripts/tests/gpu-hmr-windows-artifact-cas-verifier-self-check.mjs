import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import {
  mkdtemp,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const selfPath = fileURLToPath(import.meta.url);
const verifierPath = path.resolve(
  path.dirname(selfPath),
  '..',
  'native',
  'windows-artifact-cas-verifier.ps1',
);
const powershellExecutable = process.env.SYNTHI_WINDOWS_POWERSHELL_EXECUTABLE
  || 'powershell.exe';
const falseAuthorityFlags = [
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
];
const resultKeys = [
  'acceptedAsSnapshotEvidence',
  'acceptedForGpuHmr',
  'authority',
  'byteLength',
  'canSatisfyDispatchProof',
  'canSatisfyRuntimeProof',
  'componentIdentityChain',
  'failures',
  'finalIdentity',
  'finalObservation',
  'gpuHmrSuccess',
  'normalizedSupportPath',
  'rootIdentity',
  'schemaVersion',
  'sha256',
].sort();
const failureKeys = ['code', 'componentIndex', 'nativeStatus'].sort();
const identityKeys = ['fileId128', 'volumeSerialNumber'].sort();
const chainIdentityKeys = [
  'component',
  'componentIndex',
  'directory',
  ...identityKeys,
].sort();
const stateKeys = [
  'allocationSize',
  'changeTime',
  'creationTime',
  'deletePending',
  'directory',
  'endOfFile',
  'fileAttributes',
  'lastAccessTime',
  'lastWriteTime',
  'numberOfLinks',
].sort();

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertIdentityShape(identity, keys = identityKeys) {
  assert.deepEqual(Object.keys(identity).sort(), keys);
  assert.match(identity.volumeSerialNumber, /^[0-9a-f]{16}$/);
  assert.match(identity.fileId128, /^[0-9a-f]{32}$/);
}

function assertStateShape(state) {
  assert.deepEqual(Object.keys(state).sort(), stateKeys);
  for (const field of [
    'allocationSize',
    'changeTime',
    'creationTime',
    'endOfFile',
    'lastAccessTime',
    'lastWriteTime',
  ]) {
    assert.match(state[field], /^-?\d+$/);
  }
  assert.equal(typeof state.fileAttributes, 'number');
  assert.equal(typeof state.numberOfLinks, 'number');
  assert.equal(typeof state.deletePending, 'boolean');
  assert.equal(typeof state.directory, 'boolean');
}

function assertResultShape(result) {
  assert.deepEqual(Object.keys(result).sort(), resultKeys);
  assert.equal(typeof result.acceptedAsSnapshotEvidence, 'boolean');
  assert.equal(typeof result.authority, 'string');
  assert.ok(Array.isArray(result.failures));
  assert.ok(Array.isArray(result.componentIdentityChain));
  for (const failure of result.failures) {
    assert.deepEqual(Object.keys(failure).sort(), failureKeys);
    assert.equal(typeof failure.code, 'string');
    assert.ok(failure.componentIndex === null || Number.isInteger(failure.componentIndex));
    assert.ok(failure.nativeStatus === null || typeof failure.nativeStatus === 'string');
  }
  if (result.rootIdentity !== null) assertIdentityShape(result.rootIdentity);
  if (result.finalIdentity !== null) assertIdentityShape(result.finalIdentity);
  for (const component of result.componentIdentityChain) {
    assertIdentityShape(component, chainIdentityKeys);
    assert.equal(typeof component.component, 'string');
    assert.equal(typeof component.componentIndex, 'number');
    assert.equal(typeof component.directory, 'boolean');
  }
  if (result.finalObservation !== null) {
    assert.deepEqual(Object.keys(result.finalObservation).sort(), ['after', 'before']);
    assertStateShape(result.finalObservation.before);
    if (result.finalObservation.after !== null) assertStateShape(result.finalObservation.after);
  }
}

function verifierArguments({
  root,
  relativePath,
  expectedHash,
  expectedLength,
  maxByteLength = 64 * 1024 * 1024,
  testPipeName,
  testHoldFinalHandleMilliseconds,
}) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    verifierPath,
    '-AllowedRoot',
    root,
    '-RelativePath',
    relativePath,
    '-MaxByteLength',
    String(maxByteLength),
  ];
  if (expectedHash !== undefined) args.push('-ExpectedSha256', expectedHash);
  if (expectedLength !== undefined) {
    args.push('-ExpectedByteLength', String(expectedLength));
  }
  if (testPipeName !== undefined) {
    args.push('-TestPipeName', testPipeName);
    args.push(
      '-TestHoldFinalHandleMilliseconds',
      String(testHoldFinalHandleMilliseconds),
    );
  }
  return args;
}

async function runVerifier(request, duringRun) {
  const child = spawn(powershellExecutable, verifierArguments(request), {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const outputLimit = 1024 * 1024;
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > outputLimit) child.kill();
    else stdout.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > outputLimit) child.kill();
    else stderr.push(chunk);
  });

  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('windows artifact CAS verifier timed out'));
    }, 30_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal });
    });
  });

  const concurrent = duringRun ? duringRun(child) : Promise.resolve();
  const [{ exitCode, signal }] = await Promise.all([completion, concurrent]);
  assert.equal(signal, null, 'verifier must exit normally');
  assert.ok(stdoutBytes <= outputLimit, 'verifier stdout must be bounded');
  assert.ok(stderrBytes <= outputLimit, 'verifier stderr must be bounded');
  assert.equal(Buffer.concat(stderr).toString('utf8'), '');
  const output = Buffer.concat(stdout).toString('utf8').trim();
  const lines = output.split(/\r?\n/);
  assert.equal(lines.length, 1, `expected exactly one JSON object, got: ${output}`);
  const result = JSON.parse(lines[0]);
  assert.equal(exitCode, result.acceptedAsSnapshotEvidence ? 0 : 2);
  assertResultShape(result);
  assert.equal(result.schemaVersion, 'synthi.native_windows_artifact_cas_snapshot.v1');
  assert.equal(result.authority, 'synthi.native_windows_cas_snapshot_only.v1');
  for (const flag of falseAuthorityFlags) assert.equal(result[flag], false, flag);
  return result;
}

async function exerciseHardLinkRejection(root, relativePath) {
  const target = path.join(root, ...relativePath.split('/'));
  const aliasRelativePath = 'nested/artifact-hard-link.bin';
  const alias = path.join(root, ...aliasRelativePath.split('/'));
  await link(target, alias);
  try {
    for (const candidate of [relativePath, aliasRelativePath]) {
      const result = await runVerifier({ root, relativePath: candidate });
      assertRefused(result, 'final_link_count_invalid');
      assert.equal(result.finalObservation.before.numberOfLinks, 2);
      assert.equal(result.finalObservation.after.numberOfLinks, 2);
      assert.equal(result.finalIdentity.fileId128, result.componentIdentityChain.at(-1).fileId128);
    }
  } finally {
    await unlink(alias);
  }
}

function assertRefused(result, expectedCode) {
  assert.equal(result.acceptedAsSnapshotEvidence, false);
  assert.ok(Array.isArray(result.failures) && result.failures.length > 0);
  if (expectedCode) {
    assert.ok(
      result.failures.some(({ code }) => code === expectedCode),
      `${expectedCode} absent from ${JSON.stringify(result.failures)}`,
    );
  }
}

async function createReparse(target, link, type) {
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) return false;
    throw error;
  }
}

async function exerciseReparseRejections(base, ordinaryRoot, ordinaryRelativePath) {
  let created = 0;

  const rootJunction = path.join(base, 'root-junction');
  if (await createReparse(ordinaryRoot, rootJunction, 'junction')) {
    created += 1;
    assertRefused(
      await runVerifier({ root: rootJunction, relativePath: ordinaryRelativePath }),
      'allowed_root_component_reparse_point_rejected',
    );
  }

  const intermediateRootParent = path.join(base, 'intermediate-root-parent');
  const intermediateRootTarget = path.join(base, 'intermediate-root-target');
  const intermediateAllowedRoot = path.join(intermediateRootTarget, 'allowed-root');
  await mkdir(intermediateRootParent);
  await mkdir(intermediateAllowedRoot, { recursive: true });
  const intermediateRootJunction = path.join(intermediateRootParent, 'redirect');
  if (await createReparse(intermediateRootTarget, intermediateRootJunction, 'junction')) {
    created += 1;
    assertRefused(
      await runVerifier({
        root: path.join(intermediateRootJunction, 'allowed-root'),
        relativePath: ordinaryRelativePath,
      }),
      'allowed_root_component_reparse_point_rejected',
    );
  }

  const externalDirectory = path.join(base, 'external-directory');
  await mkdir(externalDirectory);
  await writeFile(path.join(externalDirectory, 'outside.bin'), 'outside\n');
  const childJunction = path.join(ordinaryRoot, 'child-junction');
  if (await createReparse(externalDirectory, childJunction, 'junction')) {
    created += 1;
    assertRefused(
      await runVerifier({
        root: ordinaryRoot,
        relativePath: 'child-junction/outside.bin',
      }),
      'component_reparse_point_rejected',
    );
  }

  const finalJunction = path.join(ordinaryRoot, 'final-junction');
  if (await createReparse(externalDirectory, finalJunction, 'junction')) {
    created += 1;
    assertRefused(await runVerifier({
      root: ordinaryRoot,
      relativePath: 'final-junction',
    }));
  }

  const targetFile = path.join(ordinaryRoot, ...ordinaryRelativePath.split('/'));
  const finalSymlink = path.join(ordinaryRoot, 'final-symlink.bin');
  if (await createReparse(targetFile, finalSymlink, 'file')) {
    created += 1;
    assertRefused(
      await runVerifier({ root: ordinaryRoot, relativePath: 'final-symlink.bin' }),
      'component_reparse_point_rejected',
    );
  }

  const rootSymlink = path.join(base, 'root-directory-symlink');
  if (await createReparse(ordinaryRoot, rootSymlink, 'dir')) {
    created += 1;
    assertRefused(
      await runVerifier({ root: rootSymlink, relativePath: ordinaryRelativePath }),
      'allowed_root_component_reparse_point_rejected',
    );
  }

  assert.ok(created >= 1, 'Windows must permit at least one junction/reparse self-check');
  return created;
}

const sharingViolationCodes = new Set(['EACCES', 'EBUSY', 'EPERM']);

async function captureSharingAttempt(operation) {
  try {
    await operation();
    return { blocked: false, code: null };
  } catch (error) {
    return {
      blocked: sharingViolationCodes.has(error?.code),
      code: error?.code || error?.name || 'unknown',
    };
  }
}

async function waitForReadyPipe(pipeName, child) {
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const marker = await new Promise((resolve, reject) => {
        const socket = createConnection(pipePath);
        socket.once('data', (bytes) => {
          socket.destroy();
          resolve(bytes);
        });
        socket.once('error', reject);
      });
      assert.deepEqual(marker, Buffer.from([1]));
      return;
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code)) throw error;
    }
    await sleep(5);
  }
  throw new Error('verifier did not signal retained final handle through named pipe');
}

async function exerciseExclusiveSnapshotHandle(root) {
  const relativePath = 'nested/exclusive-snapshot.bin';
  const filePath = path.join(root, ...relativePath.split('/'));
  const renamedPath = path.join(root, 'nested', 'exclusive-snapshot-renamed.bin');
  const testPipeName = `synthi-cas-test-${randomUUID().replaceAll('-', '')}`;
  const original = Buffer.alloc(8 * 1024 * 1024, 0x41);
  const changed = Buffer.alloc(original.byteLength, 0x42);
  const expectedHash = sha256(original);
  await writeFile(filePath, original);

  let writeAttempt;
  let renameAttempt;
  let deleteAttempt;
  const snapshotResult = await runVerifier({
    root,
    relativePath,
    expectedHash,
    expectedLength: original.byteLength,
    testPipeName,
    testHoldFinalHandleMilliseconds: 3000,
  }, async (child) => {
    await waitForReadyPipe(testPipeName, child);
    writeAttempt = await captureSharingAttempt(() => writeFile(filePath, changed));
    renameAttempt = await captureSharingAttempt(() => rename(filePath, renamedPath));
    deleteAttempt = await captureSharingAttempt(() => unlink(filePath));
  });
  for (const [operation, attempt] of [
    ['write', writeAttempt],
    ['rename', renameAttempt],
    ['delete', deleteAttempt],
  ]) {
    assert.equal(attempt?.blocked, true, `${operation} was not excluded: ${attempt?.code}`);
    assert.ok(sharingViolationCodes.has(attempt.code), `${operation}: ${attempt.code}`);
  }
  assertRefused(snapshotResult, 'test_hook_active_non_authoritative');
  assert.deepEqual(
    snapshotResult.failures.map(({ code }) => code),
    ['test_hook_active_non_authoritative'],
  );
  assert.equal(snapshotResult.sha256, expectedHash);
  assert.equal(snapshotResult.byteLength, original.byteLength);
  assert.deepEqual(await readFile(filePath), original, 'snapshot bytes must not tear');

  await rename(filePath, renamedPath);
  await rename(renamedPath, filePath);

  const writer = await open(filePath, 'r+');
  let writerConflictResult;
  try {
    writerConflictResult = await runVerifier({ root, relativePath });
  } finally {
    await writer.close();
  }
  assertRefused(writerConflictResult, 'component_open_failed');
  const openFailure = writerConflictResult.failures.find(
    ({ code }) => code === 'component_open_failed',
  );
  assert.equal(openFailure.componentIndex, 1);
  assert.equal(openFailure.nativeStatus, 'ntstatus:0xc0000043');
}

async function main() {
  if (process.platform !== 'win32') {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 'synthi.gpu_hmr.windows_artifact_cas_verifier_self_check.v1',
      skipped: true,
      reason: 'windows_only',
    })}\n`);
    return;
  }

  const verifierSource = await readFile(verifierPath, 'utf8');
  assert.match(verifierSource, /NtCreateFile/);
  assert.match(verifierSource, /RootDirectory = parent\.DangerousGetHandle\(\)/);
  assert.match(verifierSource, /FILE_OPEN_REPARSE_POINT/);
  assert.match(verifierSource, /FileAttributeTagInfo/);
  assert.match(verifierSource, /FileIdInfo/);
  assert.match(verifierSource, /NumberOfLinks != 1/);
  assert.match(verifierSource, /SameStableMetadata/);
  assert.match(verifierSource, /: NativeMethods\.FILE_SHARE_READ;/);
  assert.doesNotMatch(verifierSource, /FILE_SHARE_ALL/);
  assert.doesNotMatch(
    verifierSource,
    /acceptedAsSnapshotEvidence\s*=\s*(?:testReadyPath|testHoldFinalHandleMilliseconds)/i,
  );
  assert.match(verifierSource, /IndexOf\('\\0'\)/);
  assert.doesNotMatch(verifierSource, /Path\.Combine\(\s*allowedRoot/i);
  assert.doesNotMatch(
    verifierSource,
    /^\s*if\s*\([^\n]*(?:project|repository|profile|fixture|backend|engine|scenario)(?:Name|Id)?\b/im,
  );
  for (const flag of falseAuthorityFlags) {
    assert.doesNotMatch(verifierSource, new RegExp(`${flag}\\s*=\\s*true`, 'i'));
  }

  const base = await mkdtemp(path.join(os.tmpdir(), 'synthi-win-cas-self-check-'));
  const root = path.join(base, 'allowed-root');
  const nested = path.join(root, 'nested');
  const relativePath = 'nested/artifact.bin';
  const bytes = Buffer.from('native-windows-cas-snapshot\n', 'utf8');
  const expectedHash = sha256(bytes);
  let reparseCases = 0;
  try {
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'artifact.bin'), bytes);

    const positive = await runVerifier({
      root,
      relativePath,
      expectedHash,
      expectedLength: bytes.byteLength,
    });
    assert.equal(positive.acceptedAsSnapshotEvidence, true);
    assert.deepEqual(positive.failures, []);
    assert.equal(positive.normalizedSupportPath, relativePath);
    assert.equal(positive.sha256, expectedHash);
    assert.equal(positive.byteLength, bytes.byteLength);
    assert.match(positive.rootIdentity?.volumeSerialNumber, /^[0-9a-f]{16}$/);
    assert.match(positive.rootIdentity?.fileId128, /^[0-9a-f]{32}$/);
    assert.match(positive.finalIdentity?.volumeSerialNumber, /^[0-9a-f]{16}$/);
    assert.match(positive.finalIdentity?.fileId128, /^[0-9a-f]{32}$/);
    assert.equal(
      positive.finalIdentity.volumeSerialNumber,
      positive.rootIdentity.volumeSerialNumber,
    );
    assert.equal(positive.componentIdentityChain.length, 2);
    assert.equal(
      positive.componentIdentityChain.at(-1).fileId128,
      positive.finalIdentity.fileId128,
    );
    assert.equal(
      positive.finalObservation.before.endOfFile,
      positive.finalObservation.after.endOfFile,
    );
    assert.equal(
      positive.finalObservation.before.changeTime,
      positive.finalObservation.after.changeTime,
    );
    assert.equal(
      positive.finalObservation.before.lastWriteTime,
      positive.finalObservation.after.lastWriteTime,
    );
    assert.equal(
      positive.finalObservation.before.creationTime,
      positive.finalObservation.after.creationTime,
    );
    assert.equal(
      positive.finalObservation.before.allocationSize,
      positive.finalObservation.after.allocationSize,
    );
    assert.equal(
      positive.finalObservation.before.fileAttributes,
      positive.finalObservation.after.fileAttributes,
    );
    assert.equal(
      positive.finalObservation.before.deletePending,
      positive.finalObservation.after.deletePending,
    );
    assert.equal(
      positive.finalObservation.before.directory,
      positive.finalObservation.after.directory,
    );
    assert.equal(positive.finalObservation.before.numberOfLinks, 1);
    assert.equal(positive.finalObservation.after.numberOfLinks, 1);

    const stableRepeat = await runVerifier({
      root,
      relativePath,
      expectedHash,
      expectedLength: bytes.byteLength,
    });
    assert.equal(stableRepeat.acceptedAsSnapshotEvidence, true);
    assert.deepEqual(stableRepeat.rootIdentity, positive.rootIdentity);
    assert.deepEqual(stableRepeat.finalIdentity, positive.finalIdentity);

    assertRefused(
      await runVerifier({ root, relativePath, expectedHash: sha256('wrong') }),
      'expected_sha256_mismatch',
    );
    assertRefused(
      await runVerifier({ root, relativePath, expectedLength: bytes.byteLength + 1 }),
      'expected_byte_length_mismatch',
    );
    await mkdir(path.join(nested, 'not-an-artifact'));
    assertRefused(
      await runVerifier({ root, relativePath: 'nested/not-an-artifact' }),
      'final_not_regular_file',
    );
    assertRefused(
      await runVerifier({ root, relativePath, expectedHash: 'sha256:not-a-hash' }),
      'expected_sha256_invalid',
    );
    assertRefused(
      await runVerifier({ root, relativePath, expectedLength: -1 }),
      'expected_byte_length_invalid',
    );
    assertRefused(
      await runVerifier({ root, relativePath, maxByteLength: 0 }),
      'max_byte_length_invalid',
    );
    assertRefused(
      await runVerifier({ root, relativePath, maxByteLength: 1_073_741_825 }),
      'max_byte_length_out_of_range',
    );
    assertRefused(
      await runVerifier({ root: 'relative-root', relativePath }),
      'allowed_root_not_absolute',
    );
    assertRefused(
      await runVerifier({ root: '\\\\server\\share', relativePath }),
      'allowed_root_unc_rejected',
    );

    const lexicalRefusals = [
      ['../artifact.bin', 'relative_path_traversal_rejected'],
      ['nested/../artifact.bin', 'relative_path_traversal_rejected'],
      ['C:\\Windows\\win.ini', 'relative_path_absolute_rejected'],
      ['\\\\server\\share\\artifact.bin', 'relative_path_absolute_rejected'],
      ['\\\\?\\C:\\artifact.bin', 'relative_path_absolute_rejected'],
      ['artifact.bin:stream', 'relative_path_ads_rejected'],
      ['nested//artifact.bin', 'relative_path_empty_component_rejected'],
      ['./artifact.bin', 'relative_path_traversal_rejected'],
      ['artifact.bin.', 'relative_path_ambiguous_suffix_rejected'],
      ['artifact.bin ', 'relative_path_ambiguous_suffix_rejected'],
      ['artifact?.bin', 'relative_path_escaping_syntax_rejected'],
      ['NUL', 'relative_path_reserved_name_rejected'],
    ];
    for (const [candidate, failure] of lexicalRefusals) {
      assertRefused(await runVerifier({ root, relativePath: candidate }), failure);
    }

    await exerciseHardLinkRejection(root, relativePath);
    reparseCases = await exerciseReparseRejections(base, root, relativePath);
    await exerciseExclusiveSnapshotHandle(root);
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 'synthi.gpu_hmr.windows_artifact_cas_verifier_self_check.v1',
    skipped: false,
    ok: true,
    reparseCases,
    verifierSourceHash: sha256(verifierSource),
  })}\n`);
}

await main();
