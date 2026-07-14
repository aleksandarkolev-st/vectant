import { createHash } from 'node:crypto';
import path from 'node:path';

import { COLD_BUILD_OUTPUT_LABEL_MAX_BYTES } from './gpu-hmr-cold-build-container-contract.mjs';
import {
  createColdBuildInputSet,
  verifyColdBuildInputSet,
} from './gpu-hmr-cold-build-input-set.mjs';

export const ARBITRARY_COLD_PROJECT_CONTRACT_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_contract.v1';
export const ARBITRARY_COLD_PROJECT_CONTRACT_AUTHORITY =
  'declared_cold_build_contract_only_not_gpu_hmr_success';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_PATTERN = /^[A-Za-z0-9_.-]+$/;
const PINNED_CONTRACTS = new WeakMap();

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function requireSafeInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`arbitrary_cold_project_contract_${name}_invalid`);
  }
  return value;
}

function normalizeString(value, name, maximumLength = 32 * 1024) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
    || /[\0\r\n]/.test(value)
  ) {
    throw new Error(`arbitrary_cold_project_contract_${name}_invalid`);
  }
  return value;
}

function normalizeRelativePath(value, name, { allowDot = false } = {}) {
  const candidate = normalizeString(value, name);
  if (/[\\]/.test(candidate)) {
    throw new Error(`arbitrary_cold_project_contract_${name}_invalid`);
  }
  const normalized = path.posix.normalize(candidate);
  if (
    normalized !== candidate
    || (!allowDot && normalized === '.')
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    throw new Error(`arbitrary_cold_project_contract_${name}_invalid`);
  }
  return normalized;
}

function normalizeEnvironment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('arbitrary_cold_project_contract_environment_invalid');
  }
  const entries = Object.entries(value).map(([name, rawValue]) => {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new Error('arbitrary_cold_project_contract_environment_name_invalid');
    }
    const normalizedValue = String(rawValue);
    if (normalizedValue.length > 64 * 1024 || /[\0\r\n]/.test(normalizedValue)) {
      throw new Error('arbitrary_cold_project_contract_environment_value_invalid');
    }
    return [name, normalizedValue];
  });
  entries.sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > 128 || new Set(entries.map(([name]) => name)).size !== entries.length) {
    throw new Error('arbitrary_cold_project_contract_environment_invalid');
  }
  return Object.fromEntries(entries);
}

function normalizeOutput(output) {
  if (!exactKeys(output, ['path', 'role', 'artifactKind', 'mediaType'])) {
    throw new Error('arbitrary_cold_project_contract_output_shape_invalid');
  }
  const labels = {
    role: normalizeString(output.role, 'output_role'),
    artifactKind: normalizeString(output.artifactKind, 'output_artifact_kind'),
    mediaType: normalizeString(output.mediaType, 'output_media_type'),
  };
  if (Object.values(labels).some(
    (value) => Buffer.byteLength(value, 'utf8') > COLD_BUILD_OUTPUT_LABEL_MAX_BYTES,
  )) {
    throw new Error('arbitrary_cold_project_contract_output_label_invalid');
  }
  const outputPath = normalizeRelativePath(output.path, 'output_path');
  if (Buffer.byteLength(outputPath, 'utf8') > 32 * 1024) {
    throw new Error('arbitrary_cold_project_contract_output_path_invalid');
  }
  return {
    path: outputPath,
    ...labels,
    metadataAuthority: 'advisory_only_not_output_acceptance',
  };
}

function normalizeReadOnlyInput(input) {
  if (!exactKeys(input, ['mountPath', 'sourceBindingHash'])) {
    throw new Error('arbitrary_cold_project_contract_read_only_input_shape_invalid');
  }
  const mountPath = normalizeRelativePath(input.mountPath, 'read_only_input_mount_path');
  if (
    Buffer.byteLength(mountPath, 'utf8') > 1024
    || !HASH_PATTERN.test(input.sourceBindingHash ?? '')
  ) {
    throw new Error('arbitrary_cold_project_contract_read_only_input_invalid');
  }
  return {
    mountPath,
    sourceBindingHash: input.sourceBindingHash,
  };
}

function relativePathOverlaps(left, right) {
  const relative = path.posix.relative(left, right);
  return relative === '' || (relative !== '..' && !relative.startsWith('../'));
}

function contractProjection(contract) {
  return {
    schemaVersion: contract.schemaVersion,
    proofAuthority: contract.proofAuthority,
    sourceBindingHash: contract.sourceBindingHash,
    readOnlyInputs: contract.readOnlyInputs,
    inputSetBindings: contract.inputSetBindings,
    inputSetHash: contract.inputSetHash,
    workerImageId: contract.workerImageId,
    workerImageOperatingSystem: contract.workerImageOperatingSystem,
    workerImageArchitecture: contract.workerImageArchitecture,
    containerRuntime: contract.containerRuntime,
    command: contract.command,
    args: contract.args,
    environment: contract.environment,
    workingDirectory: contract.workingDirectory,
    outputManifestMode: contract.outputManifestMode,
    outputs: contract.outputs,
    resources: contract.resources,
    acceptedForGpuHmr: contract.acceptedForGpuHmr,
    gpuHmrSuccess: contract.gpuHmrSuccess,
    canSatisfyRuntimeProof: contract.canSatisfyRuntimeProof,
    canSatisfyDispatchProof: contract.canSatisfyDispatchProof,
  };
}

export function createArbitraryColdProjectContract(input) {
  if (!exactKeys(input, [
    'sourceBindingHash',
    'readOnlyInputs',
    'workerImageId',
    'workerImageOperatingSystem',
    'workerImageArchitecture',
    'containerRuntime',
    'command',
    'args',
    'environment',
    'workingDirectory',
    'outputs',
    'resources',
  ])) {
    throw new Error('arbitrary_cold_project_contract_shape_invalid');
  }
  if (!HASH_PATTERN.test(input.sourceBindingHash ?? '')) {
    throw new Error('arbitrary_cold_project_contract_source_binding_hash_invalid');
  }
  if (!Array.isArray(input.readOnlyInputs) || input.readOnlyInputs.length > 128) {
    throw new Error('arbitrary_cold_project_contract_read_only_inputs_invalid');
  }
  const readOnlyInputs = input.readOnlyInputs
    .map(normalizeReadOnlyInput)
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.mountPath, 'utf8'),
      Buffer.from(right.mountPath, 'utf8'),
    ));
  if (readOnlyInputs.some((entry, index) => (
    readOnlyInputs.slice(index + 1).some((candidate) => (
      relativePathOverlaps(entry.mountPath, candidate.mountPath)
      || relativePathOverlaps(candidate.mountPath, entry.mountPath)
    ))
  ))) {
    throw new Error('arbitrary_cold_project_contract_read_only_input_overlap');
  }
  const inputSet = createColdBuildInputSet({
    sourceBindingHash: input.sourceBindingHash,
    readOnlyInputs,
  });
  if (!HASH_PATTERN.test(input.workerImageId ?? '')) {
    throw new Error('arbitrary_cold_project_contract_worker_image_id_invalid');
  }
  if (input.workerImageOperatingSystem !== 'linux') {
    throw new Error('arbitrary_cold_project_contract_worker_image_os_invalid');
  }
  if (!['amd64', 'arm64'].includes(input.workerImageArchitecture)) {
    throw new Error('arbitrary_cold_project_contract_worker_image_architecture_invalid');
  }
  if (!RUNTIME_PATTERN.test(input.containerRuntime ?? '')) {
    throw new Error('arbitrary_cold_project_contract_runtime_invalid');
  }
  const command = normalizeString(input.command, 'command');
  if (!Array.isArray(input.args) || input.args.length > 256) {
    throw new Error('arbitrary_cold_project_contract_args_invalid');
  }
  const args = input.args.map((value) => normalizeString(value, 'argument'));
  const environment = normalizeEnvironment(input.environment);
  const workingDirectory = normalizeRelativePath(
    input.workingDirectory,
    'working_directory',
    { allowDot: true },
  );
  if (
    !Array.isArray(input.outputs)
    || input.outputs.length < 1
    || input.outputs.length > 100_000
  ) {
    throw new Error('arbitrary_cold_project_contract_outputs_invalid');
  }
  const outputs = input.outputs.map(normalizeOutput).sort((left, right) => (
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))
  ));
  if (new Set(outputs.map((output) => output.path)).size !== outputs.length) {
    throw new Error('arbitrary_cold_project_contract_output_duplicate');
  }
  if (!exactKeys(input.resources, [
    'commandTimeoutMillis',
    'releaseTimeoutMillis',
    'workspaceByteLimit',
    'workspaceEntryLimit',
    'collectedByteLimit',
    'collectedEntryLimit',
    'memoryBytes',
    'memorySwapBytes',
    'nanoCpus',
    'pidsLimit',
    'nofileLimit',
  ])) {
    throw new Error('arbitrary_cold_project_contract_resources_shape_invalid');
  }
  const resources = Object.fromEntries(Object.entries(input.resources).map(([name, value]) => [
    name,
    requireSafeInteger(value, name),
  ]));
  if (
    resources.commandTimeoutMillis < 1000
    || resources.commandTimeoutMillis > 2 * 60 * 60 * 1000
    || resources.releaseTimeoutMillis < 1000
    || resources.releaseTimeoutMillis > 10 * 60 * 1000
    || resources.workspaceByteLimit < 1024 * 1024
    || resources.pidsLimit < 16
    || resources.nofileLimit < 64
    || resources.memorySwapBytes < resources.memoryBytes
    || resources.collectedByteLimit > resources.workspaceByteLimit
    || resources.collectedEntryLimit < outputs.length + 1
    || resources.collectedEntryLimit > resources.workspaceEntryLimit
  ) {
    throw new Error('arbitrary_cold_project_contract_resources_invalid');
  }
  const contract = {
    schemaVersion: ARBITRARY_COLD_PROJECT_CONTRACT_SCHEMA,
    proofAuthority: ARBITRARY_COLD_PROJECT_CONTRACT_AUTHORITY,
    sourceBindingHash: input.sourceBindingHash,
    readOnlyInputs,
    inputSetBindings: inputSet.entries,
    inputSetHash: inputSet.inputSetHash,
    workerImageId: input.workerImageId,
    workerImageOperatingSystem: input.workerImageOperatingSystem,
    workerImageArchitecture: input.workerImageArchitecture,
    containerRuntime: input.containerRuntime,
    command,
    args,
    environment,
    workingDirectory,
    outputManifestMode: 'launcher_generated',
    outputs,
    resources,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  contract.commandSpecHash = contentHash(stableJson({
    sourceBindingHash: contract.sourceBindingHash,
    readOnlyInputs: contract.readOnlyInputs,
    inputSetHash: contract.inputSetHash,
    workerImageId: contract.workerImageId,
    workerImageOperatingSystem: contract.workerImageOperatingSystem,
    workerImageArchitecture: contract.workerImageArchitecture,
    containerRuntime: contract.containerRuntime,
    command: contract.command,
    args: contract.args,
    environment: contract.environment,
    workingDirectory: contract.workingDirectory,
    outputManifestMode: contract.outputManifestMode,
    outputs: contract.outputs,
    resources: contract.resources,
  }));
  contract.contractHash = contentHash(stableJson({
    ...contractProjection(contract),
    commandSpecHash: contract.commandSpecHash,
  }));
  PINNED_CONTRACTS.set(contract, Object.freeze({
    commandSpecHash: contract.commandSpecHash,
    contractHash: contract.contractHash,
  }));
  return contract;
}

export function verifyArbitraryColdProjectContract(contract) {
  const pinned = PINNED_CONTRACTS.get(contract);
  let inputSet;
  try {
    inputSet = createColdBuildInputSet({
      sourceBindingHash: contract?.sourceBindingHash,
      readOnlyInputs: contract?.readOnlyInputs,
    });
    verifyColdBuildInputSet({
      entries: contract?.inputSetBindings,
      inputSetHash: contract?.inputSetHash,
    }, {
      sourceBindingHash: contract?.sourceBindingHash,
      readOnlyInputs: contract?.readOnlyInputs,
    });
  } catch {
    throw new Error('arbitrary_cold_project_contract_invalid');
  }
  const commandSpecHash = contentHash(stableJson({
    sourceBindingHash: contract?.sourceBindingHash,
    readOnlyInputs: contract?.readOnlyInputs,
    inputSetHash: contract?.inputSetHash,
    workerImageId: contract?.workerImageId,
    workerImageOperatingSystem: contract?.workerImageOperatingSystem,
    workerImageArchitecture: contract?.workerImageArchitecture,
    containerRuntime: contract?.containerRuntime,
    command: contract?.command,
    args: contract?.args,
    environment: contract?.environment,
    workingDirectory: contract?.workingDirectory,
    outputManifestMode: contract?.outputManifestMode,
    outputs: contract?.outputs,
    resources: contract?.resources,
  }));
  const contractHash = contentHash(stableJson({
    ...contractProjection(contract),
    commandSpecHash,
  }));
  if (
    !pinned
    || pinned.commandSpecHash !== contract?.commandSpecHash
    || pinned.contractHash !== contract?.contractHash
    || contract?.schemaVersion !== ARBITRARY_COLD_PROJECT_CONTRACT_SCHEMA
    || contract?.proofAuthority !== ARBITRARY_COLD_PROJECT_CONTRACT_AUTHORITY
    || contract?.inputSetHash !== inputSet.inputSetHash
    || contract?.commandSpecHash !== commandSpecHash
    || contract?.contractHash !== contractHash
    || contract?.outputManifestMode !== 'launcher_generated'
    || contract?.acceptedForGpuHmr !== false
    || contract?.gpuHmrSuccess !== false
    || contract?.canSatisfyRuntimeProof !== false
    || contract?.canSatisfyDispatchProof !== false
  ) {
    throw new Error('arbitrary_cold_project_contract_invalid');
  }
  return contract;
}

export function verifyRetainedArbitraryColdProjectContract(contract) {
  if (!exactKeys(contract, [
    'schemaVersion',
    'proofAuthority',
    'sourceBindingHash',
    'readOnlyInputs',
    'inputSetBindings',
    'inputSetHash',
    'workerImageId',
    'workerImageOperatingSystem',
    'workerImageArchitecture',
    'containerRuntime',
    'command',
    'args',
    'environment',
    'workingDirectory',
    'outputManifestMode',
    'outputs',
    'resources',
    'acceptedForGpuHmr',
    'gpuHmrSuccess',
    'canSatisfyRuntimeProof',
    'canSatisfyDispatchProof',
    'commandSpecHash',
    'contractHash',
  ])) {
    throw new Error('arbitrary_cold_project_retained_contract_invalid');
  }
  let recomputed;
  try {
    recomputed = createArbitraryColdProjectContract({
      sourceBindingHash: contract.sourceBindingHash,
      readOnlyInputs: contract.readOnlyInputs,
      workerImageId: contract.workerImageId,
      workerImageOperatingSystem: contract.workerImageOperatingSystem,
      workerImageArchitecture: contract.workerImageArchitecture,
      containerRuntime: contract.containerRuntime,
      command: contract.command,
      args: contract.args,
      environment: contract.environment,
      workingDirectory: contract.workingDirectory,
      outputs: contract.outputs.map(({
        path: outputPath,
        role,
        artifactKind,
        mediaType,
      }) => ({
        path: outputPath,
        role,
        artifactKind,
        mediaType,
      })),
      resources: contract.resources,
    });
  } catch {
    throw new Error('arbitrary_cold_project_retained_contract_invalid');
  }
  if (stableJson(contract) !== stableJson(recomputed)) {
    throw new Error('arbitrary_cold_project_retained_contract_invalid');
  }
  return contract;
}
