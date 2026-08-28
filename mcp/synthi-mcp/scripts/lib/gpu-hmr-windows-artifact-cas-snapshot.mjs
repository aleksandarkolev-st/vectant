import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';
import { gzipSync } from 'node:zlib';

export const WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_SCHEMA_VERSION =
  'synthi.gpu_hmr.windows_artifact_cas_snapshot_bridge.v1';
export const WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_AUTHORITY =
  'native_windows_handle_snapshot_support_only_not_gpu_hmr_success';
export const WINDOWS_ARTIFACT_CAS_SNAPSHOT_SCHEMA_VERSION =
  'synthi.native_windows_artifact_cas_snapshot.v1';
export const WINDOWS_ARTIFACT_CAS_SNAPSHOT_AUTHORITY =
  'synthi.native_windows_cas_snapshot_only.v1';
export const WINDOWS_ARTIFACT_CAS_VERIFIER_SOURCE_HASH =
  'sha256:7c657d26e973e8ca3d2f934ffb41e916018ea0dbacbe5751e3e75cb53ac8f67f';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 60_000;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const IDENTITY_KEYS = Object.freeze(['fileId128', 'volumeSerialNumber']);
const RESULT_KEYS = Object.freeze([
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
].sort());
const INPUT_FIELDS = new Set([
  'allowedRoot',
  'relativePath',
  'expectedSha256',
  'expectedByteLength',
  'maxByteLength',
]);
const helperPath = fileURLToPath(new URL(
  '../native/windows-artifact-cas-verifier.ps1',
  import.meta.url,
));

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function refusal(gaps, details = {}) {
  return deepFreeze({
    schemaVersion: WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_SCHEMA_VERSION,
    authority: WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_AUTHORITY,
    acceptedAsSnapshotEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    helperSourceHash: details.helperSourceHash ?? null,
    interpreterHash: details.interpreterHash ?? null,
    normalizedSupportPath: details.normalizedSupportPath ?? null,
    sha256: details.sha256 ?? null,
    byteLength: details.byteLength ?? null,
    snapshotIdentity: details.snapshotIdentity ?? null,
    nativeSnapshot: details.nativeSnapshot ?? null,
    gaps: [...new Set(gaps)],
  });
}

function validateInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_input_invalid' };
  }
  try {
    if (utilTypes.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) {
      return { ok: false, gap: 'windows_artifact_cas_snapshot_input_unsafe' };
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !INPUT_FIELDS.has(key))) {
      return { ok: false, gap: 'windows_artifact_cas_snapshot_input_field_invalid' };
    }
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        return { ok: false, gap: 'windows_artifact_cas_snapshot_input_accessor_rejected' };
      }
    }
  } catch {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_input_unsafe' };
  }

  const allowedRoot = input.allowedRoot;
  const relativePath = input.relativePath;
  const expectedSha256 = input.expectedSha256;
  const expectedByteLength = input.expectedByteLength;
  const maxByteLength = input.maxByteLength ?? 256 * 1024 * 1024;
  if (typeof allowedRoot !== 'string' || allowedRoot.length === 0 || allowedRoot.length > 32767) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_allowed_root_invalid' };
  }
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.length > 32767) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_relative_path_invalid' };
  }
  if (expectedSha256 !== undefined && !SHA256_RE.test(String(expectedSha256).toLowerCase())) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_expected_hash_invalid' };
  }
  if (
    expectedByteLength !== undefined
    && (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0)
  ) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_expected_length_invalid' };
  }
  if (!Number.isSafeInteger(maxByteLength) || maxByteLength < 1 || maxByteLength > MAX_ARTIFACT_BYTES) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_max_length_invalid' };
  }
  if (expectedByteLength !== undefined && expectedByteLength > maxByteLength) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_expected_length_exceeds_maximum' };
  }
  return {
    ok: true,
    value: {
      allowedRoot,
      relativePath,
      expectedSha256: expectedSha256?.toLowerCase(),
      expectedByteLength,
      maxByteLength,
    },
  };
}

function exactPlainRecord(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expectedKeys);
}

function validIdentity(value) {
  return exactPlainRecord(value, IDENTITY_KEYS)
    && /^[0-9a-f]{32}$/.test(value.fileId128)
    && /^[0-9a-f]{16}$/.test(value.volumeSerialNumber);
}

function validateNativeSnapshot(native, request, exitCode) {
  if (!exactPlainRecord(native, RESULT_KEYS)) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_result_shape_invalid' };
  }
  if (
    native.schemaVersion !== WINDOWS_ARTIFACT_CAS_SNAPSHOT_SCHEMA_VERSION
    || native.authority !== WINDOWS_ARTIFACT_CAS_SNAPSHOT_AUTHORITY
    || native.acceptedForGpuHmr !== false
    || native.gpuHmrSuccess !== false
    || native.canSatisfyRuntimeProof !== false
    || native.canSatisfyDispatchProof !== false
    || typeof native.acceptedAsSnapshotEvidence !== 'boolean'
    || !Array.isArray(native.failures)
    || !Array.isArray(native.componentIdentityChain)
  ) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_result_contract_invalid' };
  }
  const accepted = native.acceptedAsSnapshotEvidence === true;
  if ((accepted && exitCode !== 0) || (!accepted && exitCode !== 2)) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_exit_status_mismatch' };
  }
  if (!accepted) {
    if (native.failures.length === 0) {
      return { ok: false, gap: 'windows_artifact_cas_snapshot_refusal_reason_missing' };
    }
    return {
      ok: true,
      accepted: false,
      gaps: native.failures.map((failure) => (
        typeof failure?.code === 'string'
          ? `native_windows_artifact_cas_snapshot:${failure.code}`
          : 'native_windows_artifact_cas_snapshot:failure_shape_invalid'
      )),
    };
  }
  const expectedRelativePath = request.relativePath.replaceAll('\\', '/');
  const components = expectedRelativePath.split('/');
  if (
    native.failures.length !== 0
    || native.normalizedSupportPath !== expectedRelativePath
    || !SHA256_RE.test(native.sha256)
    || !Number.isSafeInteger(native.byteLength)
    || native.byteLength < 0
    || !validIdentity(native.rootIdentity)
    || !validIdentity(native.finalIdentity)
    || native.rootIdentity.volumeSerialNumber !== native.finalIdentity.volumeSerialNumber
    || native.componentIdentityChain.length !== components.length
  ) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_accepted_result_invalid' };
  }
  if (request.expectedSha256 && native.sha256 !== request.expectedSha256) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_hash_mismatch' };
  }
  if (
    request.expectedByteLength !== undefined
    && native.byteLength !== request.expectedByteLength
  ) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_byte_length_mismatch' };
  }
  for (let index = 0; index < native.componentIdentityChain.length; index += 1) {
    const component = native.componentIdentityChain[index];
    if (
      !component
      || component.componentIndex !== index
      || component.component !== components[index]
      || typeof component.directory !== 'boolean'
      || !/^[0-9a-f]{32}$/.test(component.fileId128)
      || component.volumeSerialNumber !== native.rootIdentity.volumeSerialNumber
    ) {
      return { ok: false, gap: 'windows_artifact_cas_snapshot_identity_chain_invalid' };
    }
  }
  const before = native.finalObservation?.before;
  const after = native.finalObservation?.after;
  if (
    before === null
    || after === null
    || before?.numberOfLinks !== 1
    || after?.numberOfLinks !== 1
    || String(before?.endOfFile) !== String(native.byteLength)
    || String(after?.endOfFile) !== String(native.byteLength)
    || before?.directory !== false
    || after?.directory !== false
    || before?.deletePending !== false
    || after?.deletePending !== false
  ) {
    return { ok: false, gap: 'windows_artifact_cas_snapshot_final_observation_invalid' };
  }
  return { ok: true, accepted: true, gaps: [] };
}

function loadedSystemDirectory() {
  let sharedObjects;
  try {
    sharedObjects = process.report.getReport().sharedObjects;
  } catch {
    return null;
  }
  if (!Array.isArray(sharedObjects)) return null;
  const required = new Map([
    ['kernel32.dll', null],
    ['ntdll.dll', null],
  ]);
  for (const value of sharedObjects) {
    if (typeof value !== 'string') continue;
    const name = path.basename(value).toLowerCase();
    if (required.has(name)) required.set(name, path.dirname(path.resolve(value)));
  }
  const directories = [...required.values()];
  if (directories.some((value) => value === null)) return null;
  const normalized = new Set(directories.map((value) => value.toLowerCase()));
  return normalized.size === 1 ? directories[0] : null;
}

function helperCommand(normalizedHelperBytes, request) {
  const source = gzipSync(normalizedHelperBytes, { level: 9 }).toString('base64');
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const command = [
    "$ErrorActionPreference='Stop'",
    `$memory=[IO.MemoryStream]::new([Convert]::FromBase64String('${source}'))`,
    '$gzip=[IO.Compression.GzipStream]::new($memory,[IO.Compression.CompressionMode]::Decompress)',
    '$reader=[IO.StreamReader]::new($gzip,[Text.UTF8Encoding]::new($false))',
    '$source=$reader.ReadToEnd()',
    `$request=ConvertFrom-Json([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`,
    "$invoke=@('-AllowedRoot',[string]$request.allowedRoot,'-RelativePath',[string]$request.relativePath,'-MaxByteLength',[string]$request.maxByteLength)",
    "if($null -ne $request.expectedSha256){$invoke+=@('-ExpectedSha256',[string]$request.expectedSha256)}",
    "if($null -ne $request.expectedByteLength){$invoke+=@('-ExpectedByteLength',[string]$request.expectedByteLength)}",
    '& ([ScriptBlock]::Create($source)) @invoke',
  ].join(';');
  return command.length <= 24_000 ? command : null;
}

async function captureProcess(executable, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminated = false;
    const terminate = (reason) => {
      if (terminated) return;
      terminated = true;
      child.kill();
      resolve({ ok: false, reason, exitCode: null, stdout: null });
    };
    const timer = setTimeout(() => terminate('windows_artifact_cas_snapshot_process_timeout'), PROCESS_TIMEOUT_MS);
    child.once('error', () => terminate('windows_artifact_cas_snapshot_process_spawn_failed'));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_CAPTURE_BYTES) terminate('windows_artifact_cas_snapshot_stdout_exceeded');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > MAX_CAPTURE_BYTES) terminate('windows_artifact_cas_snapshot_stderr_exceeded');
      else stderr.push(chunk);
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (terminated) return;
      terminated = true;
      if (signal !== null || stderrBytes !== 0) {
        resolve({ ok: false, reason: 'windows_artifact_cas_snapshot_process_failed', exitCode, stdout: null });
        return;
      }
      resolve({
        ok: true,
        reason: null,
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}

export async function verifyWindowsArtifactCasSnapshot(input) {
  const checked = validateInput(input);
  if (!checked.ok) return refusal([checked.gap]);
  if (process.platform !== 'win32') {
    return refusal(['windows_artifact_cas_snapshot_platform_unavailable']);
  }

  let helperBytes;
  try {
    helperBytes = await readFile(helperPath);
  } catch {
    return refusal(['windows_artifact_cas_snapshot_helper_unreadable']);
  }
  const normalizedHelperBytes = Buffer.from(
    helperBytes.toString('utf8').replaceAll('\r\n', '\n'),
    'utf8',
  );
  const helperSourceHash = sha256(normalizedHelperBytes);
  if (helperSourceHash !== WINDOWS_ARTIFACT_CAS_VERIFIER_SOURCE_HASH) {
    return refusal(['windows_artifact_cas_snapshot_helper_hash_mismatch'], { helperSourceHash });
  }

  const systemDirectory = loadedSystemDirectory();
  if (systemDirectory === null) {
    return refusal(['windows_artifact_cas_snapshot_loaded_system_directory_unavailable'], {
      helperSourceHash,
    });
  }
  const executable = path.join(
    systemDirectory,
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  let interpreterBytes;
  let canonicalExecutable;
  try {
    canonicalExecutable = await realpath(executable);
    const canonicalSystemDirectory = await realpath(systemDirectory);
    const executableRelative = path.relative(canonicalSystemDirectory, canonicalExecutable);
    if (executableRelative.startsWith('..') || path.isAbsolute(executableRelative)) {
      return refusal(['windows_artifact_cas_snapshot_interpreter_outside_loaded_system_directory'], {
        helperSourceHash,
      });
    }
    const executableStat = await lstat(executable);
    if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
      return refusal(['windows_artifact_cas_snapshot_interpreter_not_regular_file'], { helperSourceHash });
    }
    interpreterBytes = await readFile(executable);
  } catch {
    return refusal(['windows_artifact_cas_snapshot_interpreter_unreadable'], { helperSourceHash });
  }
  const interpreterHash = sha256(interpreterBytes);
  const request = checked.value;
  const command = helperCommand(normalizedHelperBytes, request);
  if (command === null) {
    return refusal(['windows_artifact_cas_snapshot_command_length_exceeded'], {
      helperSourceHash,
      interpreterHash,
    });
  }
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ];
  const systemRoot = path.dirname(systemDirectory);
  const execution = await captureProcess(executable, args, {
    OS: 'Windows_NT',
    SystemRoot: systemRoot,
    windir: systemRoot,
    ComSpec: path.join(systemRoot, 'System32', 'cmd.exe'),
    PATH: [
      path.join(systemRoot, 'System32'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    ].join(path.delimiter),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  }, systemDirectory);
  if (!execution.ok) {
    return refusal([execution.reason], { helperSourceHash, interpreterHash });
  }
  const output = execution.stdout.trim();
  if (output.length === 0 || output.split(/\r?\n/).length !== 1) {
    return refusal(['windows_artifact_cas_snapshot_output_shape_invalid'], {
      helperSourceHash,
      interpreterHash,
    });
  }
  let nativeSnapshot;
  try {
    nativeSnapshot = JSON.parse(output);
  } catch {
    return refusal(['windows_artifact_cas_snapshot_output_json_invalid'], {
      helperSourceHash,
      interpreterHash,
    });
  }
  const validation = validateNativeSnapshot(nativeSnapshot, request, execution.exitCode);
  const details = {
    helperSourceHash,
    interpreterHash,
    normalizedSupportPath: nativeSnapshot.normalizedSupportPath ?? null,
    sha256: nativeSnapshot.sha256 ?? null,
    byteLength: nativeSnapshot.byteLength ?? null,
    snapshotIdentity: nativeSnapshot.acceptedAsSnapshotEvidence === true
      ? {
          root: nativeSnapshot.rootIdentity,
          final: nativeSnapshot.finalIdentity,
          components: nativeSnapshot.componentIdentityChain,
          before: nativeSnapshot.finalObservation?.before ?? null,
          after: nativeSnapshot.finalObservation?.after ?? null,
        }
      : null,
    nativeSnapshot,
  };
  if (!validation.ok || validation.accepted !== true) {
    return refusal(validation.gaps ?? [validation.gap], details);
  }
  return deepFreeze({
    schemaVersion: WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_SCHEMA_VERSION,
    authority: WINDOWS_ARTIFACT_CAS_SNAPSHOT_BRIDGE_AUTHORITY,
    acceptedAsSnapshotEvidence: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    helperSourceHash,
    interpreterHash,
    normalizedSupportPath: nativeSnapshot.normalizedSupportPath,
    sha256: nativeSnapshot.sha256,
    byteLength: nativeSnapshot.byteLength,
    snapshotIdentity: details.snapshotIdentity,
    nativeSnapshot,
    gaps: [],
  });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}
