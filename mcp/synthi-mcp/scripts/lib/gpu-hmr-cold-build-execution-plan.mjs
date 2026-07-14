import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  open,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
  computeColdBuildSourceTreeBinding,
  verifyColdBuildSourceTreeBindingEvidence,
} from './gpu-hmr-cold-build-source-tree-binding.mjs';
import {
  createColdBuildInputSet,
  verifyColdBuildInputSet,
} from './gpu-hmr-cold-build-input-set.mjs';
import {
  COLD_BUILD_CONTAINER_CAPABILITIES,
  COLD_BUILD_CONTAINER_COMMAND_GID,
  COLD_BUILD_CONTAINER_COMMAND_UID,
  COLD_BUILD_LAUNCHER_CONTAINER_PATH,
  COLD_BUILD_LAUNCHER_CONTROL_ROOT,
  COLD_BUILD_LAUNCHER_INPUT_ROOT,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
  COLD_BUILD_LAUNCHER_RELEASE_ROOT,
  COLD_BUILD_LAUNCHER_SOURCE_ROOT,
  COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
  COLD_BUILD_OUTPUT_MANIFEST_MODE_COMMAND_PROVIDED,
  coldBuildControlTmpfsOptions,
  coldBuildLauncherCommand,
  coldBuildLauncherEntrypoint,
  coldBuildLauncherSpec,
  coldBuildLauncherSpecHash,
  coldBuildOutputTmpfsOptions,
  coldBuildTmpfsOptions,
  encodeColdBuildLauncherSpec,
} from './gpu-hmr-cold-build-container-contract.mjs';

export const COLD_BUILD_EXECUTION_PLAN_SCHEMA =
  'synthi.gpu_hmr.cold_build_execution_plan.v1';
export const COLD_BUILD_EXECUTION_PLAN_AUTHORITY =
  'cold_build_execution_plan_only_not_gpu_hmr_success';
export const COLD_BUILD_EXECUTION_PLAN_RECEIPT_SCHEMA =
  'synthi.gpu_hmr.cold_build_execution_plan_receipt.v1';
export const COLD_BUILD_EXECUTION_PLAN_RECEIPT_AUTHORITY =
  'serialized_execution_plan_projection_only_not_gpu_hmr_success';
export const COLD_BUILD_CONTAINER_INSPECTION_SCHEMA =
  'synthi.gpu_hmr.cold_build_container_inspection.v1';
export const COLD_BUILD_CONTAINER_INSPECTION_AUTHORITY =
  'observed_container_configuration_only_not_gpu_hmr_success';
export const COLD_BUILD_EXECUTION_INPUTS_SCHEMA =
  'synthi.gpu_hmr.cold_build_execution_inputs.v1';
export const COLD_BUILD_EXECUTION_INPUTS_AUTHORITY =
  'observed_execution_input_identity_only_not_gpu_hmr_success';
export const COLD_BUILD_SPEC_PUBLICATION_SCHEMA =
  'synthi.gpu_hmr.cold_build_spec_publication.v1';
export const COLD_BUILD_SPEC_PUBLICATION_AUTHORITY =
  'exclusive_content_addressed_spec_publication_only_not_gpu_hmr_success';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const EXECUTION_NONCE_PATTERN = /^[a-f0-9]{32}$/;
const CONTAINER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PINNED_EXECUTION_PLANS = new WeakMap();
const PINNED_INPUT_EVIDENCE = new WeakMap();
const PINNED_SPEC_PUBLICATIONS = new WeakMap();
const INPUT_OBSERVATION_SEQUENCE = new WeakMap();
const EXECUTION_PLAN_PROJECTION_KEYS = [
  'schemaVersion',
  'proofAuthority',
  'executionNonce',
  'commandSpecHash',
  'sourceBindingHash',
  'sourceTreeBindingEvidenceHash',
  'inputSetBindings',
  'inputSetHash',
  'readOnlyInputTreesHash',
  'releaseBindingHash',
  'releaseTreeBindingEvidenceHash',
  'specHash',
  'specByteLength',
  'launcherExecutableHash',
  'launcherBuildEvidenceHash',
  'workerImageId',
  'workerImageOperatingSystem',
  'workerImageArchitecture',
  'containerNameHash',
  'sourcePathIdentityHash',
  'releasePathIdentityHash',
  'specPathIdentityHash',
  'launcherPathIdentityHash',
  'commandHash',
  'environmentHash',
  'resourcePolicy',
  'expectedContainerConfiguration',
  'containerCreateArgsHash',
  'collectorCommandHash',
  'readyReceiptRequired',
  'canAuthorizeLauncherExecution',
  'planValid',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
];

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function contentHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function recomputeEvidenceHash(evidence) {
  const projection = { ...evidence };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function requireSafeInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`cold_build_execution_plan_${name}_invalid`);
  }
  return value;
}

function requireHash(value, name) {
  if (!SHA256_PATTERN.test(value ?? '')) {
    throw new Error(`cold_build_execution_plan_${name}_invalid`);
  }
  return value;
}

function requireHostPath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`cold_build_execution_plan_${name}_invalid`);
  }
  return path.resolve(value);
}

function dockerMountField(name, value) {
  return `"${name}=${String(value).replaceAll('"', '""')}"`;
}

function dockerBindMount(source, target) {
  return [
    'type=bind',
    dockerMountField('source', source),
    dockerMountField('target', target),
    'readonly',
  ].join(',');
}

function normalizeEnvironment(environment) {
  const entries = Array.isArray(environment)
    ? environment
    : Object.entries(environment ?? {}).map(([name, value]) => `${name}=${value}`);
  const byName = new Map();
  for (const entry of entries) {
    if (typeof entry !== 'string' || /[\0\r\n]/.test(entry)) {
      throw new Error('cold_build_execution_plan_environment_invalid');
    }
    const separator = entry.indexOf('=');
    const name = separator > 0 ? entry.slice(0, separator) : '';
    if (!ENVIRONMENT_NAME_PATTERN.test(name) || byName.has(name)) {
      throw new Error('cold_build_execution_plan_environment_invalid');
    }
    byName.set(name, entry);
  }
  return [...byName.values()].sort();
}

function normalizeCommandArguments(args) {
  if (!Array.isArray(args) || args.some(
    (value) => typeof value !== 'string' || /[\0]/.test(value),
  )) {
    throw new Error('cold_build_execution_plan_command_args_invalid');
  }
  return [...args];
}

function normalizeWorkingDirectory(value) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) {
    throw new Error('cold_build_execution_plan_working_directory_invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    !path.posix.isAbsolute(normalized)
    || (
      normalized !== COLD_BUILD_LAUNCHER_SOURCE_ROOT
      && !normalized.startsWith(`${COLD_BUILD_LAUNCHER_SOURCE_ROOT}/`)
    )
  ) {
    throw new Error('cold_build_execution_plan_working_directory_invalid');
  }
  return normalized;
}

function normalizedHostPathIdentity(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized;
}

function pathIdentityHash(value) {
  return contentHash(normalizedHostPathIdentity(value));
}

function normalizeReadOnlyInputMountPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024 || /[\\\0\r\n]/.test(value)) {
    throw new Error('cold_build_execution_plan_read_only_input_mount_path_invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    throw new Error('cold_build_execution_plan_read_only_input_mount_path_invalid');
  }
  return normalized;
}

function readOnlyInputTreeProjection(input) {
  return {
    mountPath: input.mountPath,
    containerPath: input.containerPath,
    sourceBindingHash: input.sourceBindingHash,
    sourceTreeBindingEvidenceHash: input.sourceTreeBindingEvidenceHash,
    hostPathIdentityHash: input.hostPathIdentityHash,
  };
}

function readOnlyInputTreeMaterialAccepted(input) {
  return pathIdentityHash(input.hostPath) === input.hostPathIdentityHash
    && recomputeEvidenceHash(input.sourceTreeBindingEvidence)
      === input.sourceTreeBindingEvidenceHash
    && input.sourceTreeBindingEvidence?.sourceBindingHash === input.sourceBindingHash
    && input.containerPath === path.posix.join(COLD_BUILD_LAUNCHER_INPUT_ROOT, input.mountPath);
}

function executionPlanInputSetAccepted(plan) {
  try {
    return verifyColdBuildInputSet({
      entries: plan?.inputSetBindings,
      inputSetHash: plan?.inputSetHash,
    }, {
      sourceBindingHash: plan?.sourceBindingHash,
      readOnlyInputs: (plan?.readOnlyInputTrees ?? []).map((input) => ({
        mountPath: input.mountPath,
        sourceBindingHash: input.sourceBindingHash,
      })),
    }) != null;
  } catch {
    return false;
  }
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function normalizeCapabilities(value) {
  return normalizeStringArray(value)
    .map((capability) => capability.toUpperCase().replace(/^CAP_/, ''))
    .sort();
}

function normalizeSecurityOptions(value) {
  return normalizeStringArray(value)
    .map((option) => [
      'no-new-privileges',
      'no-new-privileges:true',
      'no-new-privileges=true',
    ].includes(option) ? 'no-new-privileges=true' : option)
    .sort();
}

function normalizeTmpfsOptions(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
}

function normalizeUlimits(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => ({
      name: String(entry?.Name ?? entry?.name ?? ''),
      soft: Number(entry?.Soft ?? entry?.soft),
      hard: Number(entry?.Hard ?? entry?.hard),
    }))
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function normalizeMounts(value) {
  return (Array.isArray(value) ? value : [])
    .map((mount) => ({
      type: String(mount?.Type ?? mount?.type ?? ''),
      sourceIdentityHash: pathIdentityHash(String(mount?.Source ?? mount?.source ?? '.')),
      destination: String(mount?.Destination ?? mount?.destination ?? ''),
      readWrite: mount?.RW === true || mount?.readWrite === true,
      propagation: String(mount?.Propagation ?? mount?.propagation ?? ''),
    }))
    .sort((left, right) => left.destination.localeCompare(right.destination));
}

function executionPlanProjection(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    proofAuthority: plan.proofAuthority,
    executionNonce: plan.executionNonce,
    commandSpecHash: plan.commandSpecHash,
    sourceBindingHash: plan.sourceBindingHash,
    sourceTreeBindingEvidenceHash: plan.sourceTreeBindingEvidenceHash,
    inputSetBindings: plan.inputSetBindings,
    inputSetHash: plan.inputSetHash,
    readOnlyInputTreesHash: plan.readOnlyInputTreesHash,
    releaseBindingHash: plan.releaseBindingHash,
    releaseTreeBindingEvidenceHash: plan.releaseTreeBindingEvidenceHash,
    specHash: plan.specHash,
    specByteLength: plan.specByteLength,
    launcherExecutableHash: plan.launcherExecutableHash,
    launcherBuildEvidenceHash: plan.launcherBuildEvidenceHash,
    workerImageId: plan.workerImageId,
    workerImageOperatingSystem: plan.workerImageOperatingSystem,
    workerImageArchitecture: plan.workerImageArchitecture,
    containerNameHash: plan.containerNameHash,
    sourcePathIdentityHash: plan.sourcePathIdentityHash,
    releasePathIdentityHash: plan.releasePathIdentityHash,
    specPathIdentityHash: plan.specPathIdentityHash,
    launcherPathIdentityHash: plan.launcherPathIdentityHash,
    commandHash: plan.commandHash,
    environmentHash: plan.environmentHash,
    resourcePolicy: plan.resourcePolicy,
    expectedContainerConfiguration: plan.expectedContainerConfiguration,
    containerCreateArgsHash: plan.containerCreateArgsHash,
    collectorCommandHash: plan.collectorCommandHash,
    readyReceiptRequired: plan.readyReceiptRequired,
    canAuthorizeLauncherExecution: plan.canAuthorizeLauncherExecution,
    planValid: plan.planValid,
    acceptedForGpuHmr: plan.acceptedForGpuHmr,
    gpuHmrSuccess: plan.gpuHmrSuccess,
    canSatisfyRuntimeProof: plan.canSatisfyRuntimeProof,
    canSatisfyDispatchProof: plan.canSatisfyDispatchProof,
  };
}

export function createColdBuildExecutionPlanReceipt(plan) {
  const pinned = PINNED_EXECUTION_PLANS.get(plan);
  const planProjection = executionPlanProjection(plan);
  const planHash = contentHash(stableJson(planProjection));
  if (
    !pinned
    || pinned.launcherIdentity !== plan?.launcherIdentity
    || pinned.projectionHash !== planHash
    || plan?.planHash !== planHash
    || !executionPlanMaterialAccepted(plan)
  ) {
    throw new Error('cold_build_execution_plan_receipt_source_invalid');
  }
  const receipt = {
    schemaVersion: COLD_BUILD_EXECUTION_PLAN_RECEIPT_SCHEMA,
    proofAuthority: COLD_BUILD_EXECUTION_PLAN_RECEIPT_AUTHORITY,
    planProjection: structuredClone(planProjection),
    planHash,
    acceptedAsColdBuildExecutionPlanReceipt: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  receipt.evidenceHash = recomputeEvidenceHash(receipt);
  return receipt;
}

export function verifyColdBuildExecutionPlanReceipt(receipt) {
  const projection = receipt?.planProjection;
  const hashFields = [
    'commandSpecHash',
    'sourceBindingHash',
    'sourceTreeBindingEvidenceHash',
    'inputSetHash',
    'readOnlyInputTreesHash',
    'releaseBindingHash',
    'releaseTreeBindingEvidenceHash',
    'specHash',
    'launcherExecutableHash',
    'workerImageId',
    'containerNameHash',
    'sourcePathIdentityHash',
    'releasePathIdentityHash',
    'specPathIdentityHash',
    'launcherPathIdentityHash',
    'commandHash',
    'environmentHash',
    'containerCreateArgsHash',
    'collectorCommandHash',
  ];
  if (
    !exactKeys(receipt, [
      'schemaVersion',
      'proofAuthority',
      'planProjection',
      'planHash',
      'acceptedAsColdBuildExecutionPlanReceipt',
      'acceptedForGpuHmr',
      'gpuHmrSuccess',
      'canSatisfyRuntimeProof',
      'canSatisfyDispatchProof',
      'evidenceHash',
    ])
    || receipt.schemaVersion !== COLD_BUILD_EXECUTION_PLAN_RECEIPT_SCHEMA
    || receipt.proofAuthority !== COLD_BUILD_EXECUTION_PLAN_RECEIPT_AUTHORITY
    || !exactKeys(projection, EXECUTION_PLAN_PROJECTION_KEYS)
    || projection.schemaVersion !== COLD_BUILD_EXECUTION_PLAN_SCHEMA
    || projection.proofAuthority !== COLD_BUILD_EXECUTION_PLAN_AUTHORITY
    || !EXECUTION_NONCE_PATTERN.test(projection.executionNonce ?? '')
    || hashFields.some((name) => !SHA256_PATTERN.test(projection[name] ?? ''))
    || (projection.launcherBuildEvidenceHash !== null
      && !SHA256_PATTERN.test(projection.launcherBuildEvidenceHash ?? ''))
    || !Array.isArray(projection.inputSetBindings)
    || projection.inputSetHash !== contentHash(stableJson(projection.inputSetBindings))
    || !Number.isSafeInteger(projection.specByteLength)
    || projection.specByteLength < 2
    || projection.workerImageOperatingSystem !== 'linux'
    || !['amd64', 'arm64'].includes(projection.workerImageArchitecture)
    || projection.expectedContainerConfiguration?.imageId !== projection.workerImageId
    || projection.readyReceiptRequired !== true
    || projection.canAuthorizeLauncherExecution !== false
    || projection.planValid !== true
    || projection.acceptedForGpuHmr !== false
    || projection.gpuHmrSuccess !== false
    || projection.canSatisfyRuntimeProof !== false
    || projection.canSatisfyDispatchProof !== false
    || receipt.planHash !== contentHash(stableJson(projection))
    || receipt.acceptedAsColdBuildExecutionPlanReceipt !== true
    || receipt.acceptedForGpuHmr !== false
    || receipt.gpuHmrSuccess !== false
    || receipt.canSatisfyRuntimeProof !== false
    || receipt.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(receipt) !== receipt.evidenceHash
  ) {
    throw new Error('cold_build_execution_plan_receipt_invalid');
  }
  return receipt;
}

function executionPlanMaterialAccepted(plan) {
  const encodedSpec = encodeColdBuildLauncherSpec(plan.spec);
  return Buffer.isBuffer(plan.specBytes)
    && plan.specBytes.byteLength === plan.specByteLength
    && encodedSpec.equals(plan.specBytes)
    && coldBuildLauncherSpecHash(plan.spec) === plan.specHash
    && contentHash(plan.specBytes) === plan.specHash
    && contentHash(stableJson(plan.containerCreateArgs)) === plan.containerCreateArgsHash
    && contentHash(stableJson(plan.collectorCommand)) === plan.collectorCommandHash
    && contentHash(plan.containerName) === plan.containerNameHash
    && pathIdentityHash(plan.sourceHostPath) === plan.sourcePathIdentityHash
    && pathIdentityHash(plan.releaseHostPath) === plan.releasePathIdentityHash
    && pathIdentityHash(plan.specHostPath) === plan.specPathIdentityHash
    && normalizedHostPathIdentity(path.dirname(plan.specHostPath))
      === normalizedHostPathIdentity(plan.specHostDirectory)
    && path.basename(plan.specHostPath)
      === `${plan.specHash.slice('sha256:'.length)}.json`
    && pathIdentityHash(plan.launcherHostPath) === plan.launcherPathIdentityHash
    && contentHash(stableJson(plan.spec.command)) === plan.commandHash
    && contentHash(stableJson(plan.spec.environment)) === plan.environmentHash
    && recomputeEvidenceHash(plan.sourceTreeBindingEvidence)
      === plan.sourceTreeBindingEvidenceHash
    && plan.sourceTreeBindingEvidence?.sourceBindingHash === plan.sourceBindingHash
    && executionPlanInputSetAccepted(plan)
    && contentHash(stableJson(plan.readOnlyInputTrees.map(readOnlyInputTreeProjection)))
      === plan.readOnlyInputTreesHash
    && plan.readOnlyInputTrees.every(readOnlyInputTreeMaterialAccepted)
    && recomputeEvidenceHash(plan.releaseTreeBindingEvidence)
      === plan.releaseTreeBindingEvidenceHash
    && plan.releaseTreeBindingEvidence?.sourceBindingHash === plan.releaseBindingHash
    && plan.launcherExecutableHash === plan.launcherIdentity?.binaryHash
    && plan.launcherBuildEvidenceHash
      === (plan.launcherIdentity?.buildEvidence?.evidenceHash ?? null)
    && plan.workerImageOperatingSystem === 'linux'
    && plan.workerImageArchitecture === plan.launcherIdentity?.architecture
    && plan.workerImageId === plan.expectedContainerConfiguration?.imageId;
}

function requireContainerId(value) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) {
    throw new Error('cold_build_container_id_invalid');
  }
  return value;
}

function metadataProjection(metadata) {
  return {
    device: String(metadata.dev),
    inode: String(metadata.ino),
    mode: Number(metadata.mode),
    ownerUserId: String(metadata.uid),
    ownerGroupId: String(metadata.gid),
    linkCount: Number(metadata.nlink),
    size: String(metadata.size),
    modifiedNanoseconds: String(metadata.mtimeNs),
    changedNanoseconds: String(metadata.ctimeNs),
  };
}

function sameFileMetadata(left, right) {
  return left?.size === right?.size
    && left?.mode === right?.mode
    && left?.nlink === right?.nlink
    && left?.uid === right?.uid
    && left?.gid === right?.gid
    && left?.mtimeNs === right?.mtimeNs
    && left?.ctimeNs === right?.ctimeNs;
}

function samePathFileIdentity(left, right) {
  if (process.platform === 'win32') {
    return typeof left?.ino === 'bigint'
      && left.ino !== 0n
      && left.ino === right?.ino;
  }
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameOpenFileIdentity(left, right) {
  return typeof left?.dev === 'bigint'
    && typeof left?.ino === 'bigint'
    && left.ino !== 0n
    && left.dev === right?.dev
    && left.ino === right?.ino;
}

async function readStableRegularFile(filePath, maxByteLength = Number.MAX_SAFE_INTEGER) {
  const beforePath = await lstat(filePath, { bigint: true });
  const handle = await open(filePath, 'r');
  let verificationHandle = null;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxByteLength)) {
      throw new Error('cold_build_execution_input_file_bounds_invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    verificationHandle = await open(filePath, 'r');
    const verification = await verificationHandle.stat({ bigint: true });
    const finalPath = await lstat(filePath, { bigint: true });
    if (
      beforePath.isSymbolicLink()
      || pathAfter.isSymbolicLink()
      || finalPath.isSymbolicLink()
      || !samePathFileIdentity(beforePath, pathAfter)
      || !samePathFileIdentity(pathAfter, finalPath)
      || !samePathFileIdentity(finalPath, verification)
      || !sameOpenFileIdentity(before, after)
      || !sameOpenFileIdentity(after, verification)
      || !sameFileMetadata(beforePath, before)
      || !sameFileMetadata(before, after)
      || !sameFileMetadata(after, pathAfter)
      || !sameFileMetadata(pathAfter, verification)
      || !sameFileMetadata(verification, finalPath)
      || BigInt(bytes.byteLength) !== after.size
    ) {
      throw new Error('cold_build_execution_input_file_identity_changed');
    }
    return { bytes, metadata: verification };
  } finally {
    await verificationHandle?.close().catch(() => {});
    await handle.close();
  }
}

async function inspectExecutionInput(filePath, expectedKind, expectedContentHash = null) {
  const plannedPath = path.resolve(filePath);
  const symbolicMetadata = await lstat(plannedPath, { bigint: true });
  const canonicalPath = await realpath(plannedPath);
  let canonicalMetadata = await stat(canonicalPath, { bigint: true });
  const kindAccepted = expectedKind === 'directory'
    ? canonicalMetadata.isDirectory()
    : canonicalMetadata.isFile();
  const pathAccepted = !symbolicMetadata.isSymbolicLink()
    && samePathFileIdentity(symbolicMetadata, canonicalMetadata);
  let observedContentHash = null;
  let contentHashAccepted = expectedContentHash === null;
  if (expectedKind === 'file') {
    const stableFile = await readStableRegularFile(canonicalPath);
    canonicalMetadata = stableFile.metadata;
    const { bytes } = stableFile;
    observedContentHash = contentHash(bytes);
    contentHashAccepted = observedContentHash === expectedContentHash;
  }
  const metadata = metadataProjection(canonicalMetadata);
  return {
    plannedPathIdentityHash: pathIdentityHash(plannedPath),
    canonicalPathIdentityHash: pathIdentityHash(canonicalPath),
    expectedKind,
    kindAccepted,
    symbolicLink: symbolicMetadata.isSymbolicLink(),
    pathAccepted,
    metadata,
    metadataHash: contentHash(stableJson(metadata)),
    expectedContentHash,
    observedContentHash,
    contentHashAccepted,
    accepted: pathAccepted && kindAccepted && contentHashAccepted,
  };
}

function isPathWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function isPosixPathWithin(candidate, parent) {
  const relative = path.posix.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('../'));
}

export function createColdBuildLauncherExecutionPlan({
  launcherIdentity,
  executionNonce,
  commandSpecHash,
  sourceTreeBindingEvidence,
  readOnlyInputTrees = [],
  releaseTreeBindingEvidence,
  command,
  args = [],
  environment = [],
  workingDirectory = COLD_BUILD_LAUNCHER_SOURCE_ROOT,
  commandTimeoutMillis,
  releaseTimeoutMillis,
  workspaceByteLimit,
  workspaceEntryLimit,
  collectedByteLimit,
  collectedEntryLimit,
  outputManifestMode = COLD_BUILD_OUTPUT_MANIFEST_MODE_COMMAND_PROVIDED,
  declaredOutputs = [],
  containerName,
  workerImageId,
  workerImageEnvironment,
  workerImageOperatingSystem,
  workerImageArchitecture,
  containerRuntime,
  sourceHostPath,
  releaseHostPath,
  specHostDirectory,
  memoryBytes,
  memorySwapBytes = memoryBytes,
  nanoCpus,
  pidsLimit = 1024,
  nofileLimit = 4096,
} = {}) {
  if (!EXECUTION_NONCE_PATTERN.test(executionNonce ?? '')) {
    throw new Error('cold_build_execution_plan_execution_nonce_invalid');
  }
  requireHash(commandSpecHash, 'command_spec_hash');
  requireHash(workerImageId, 'worker_image_id');
  if (workerImageOperatingSystem !== 'linux') {
    throw new Error('cold_build_execution_plan_worker_image_operating_system_invalid');
  }
  if (!['amd64', 'arm64'].includes(workerImageArchitecture)) {
    throw new Error('cold_build_execution_plan_worker_image_architecture_invalid');
  }
  if (launcherIdentity?.architecture !== workerImageArchitecture) {
    throw new Error('cold_build_execution_plan_launcher_architecture_mismatch');
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(containerRuntime ?? '')) {
    throw new Error('cold_build_execution_plan_container_runtime_invalid');
  }
  const normalizedWorkerImageEnvironment = normalizeEnvironment(workerImageEnvironment);
  if (!CONTAINER_NAME_PATTERN.test(containerName ?? '')) {
    throw new Error('cold_build_execution_plan_container_name_invalid');
  }
  if (typeof command !== 'string' || command.length === 0 || /[\0\r\n]/.test(command)) {
    throw new Error('cold_build_execution_plan_command_invalid');
  }
  const normalizedArgs = normalizeCommandArguments(args);
  const normalizedEnvironment = normalizeEnvironment(environment);
  const normalizedWorkingDirectory = normalizeWorkingDirectory(workingDirectory);
  const sourcePath = requireHostPath(sourceHostPath, 'source_path');
  const verifiedSourceTreeBinding = verifyColdBuildSourceTreeBindingEvidence(
    sourceTreeBindingEvidence,
    sourcePath,
  );
  const sourceBindingHash = verifiedSourceTreeBinding.sourceBindingHash;
  if (!Array.isArray(readOnlyInputTrees) || readOnlyInputTrees.length > 128) {
    throw new Error('cold_build_execution_plan_read_only_inputs_invalid');
  }
  const normalizedReadOnlyInputTrees = readOnlyInputTrees.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || stableJson(Object.keys(entry).sort())
        !== stableJson(['hostPath', 'mountPath', 'sourceTreeBindingEvidence'].sort())
    ) {
      throw new Error('cold_build_execution_plan_read_only_input_shape_invalid');
    }
    const hostPath = requireHostPath(entry.hostPath, 'read_only_input_host_path');
    const mountPath = normalizeReadOnlyInputMountPath(entry.mountPath);
    const sourceTreeBindingEvidence = verifyColdBuildSourceTreeBindingEvidence(
      entry.sourceTreeBindingEvidence,
      hostPath,
    );
    return {
      hostPath,
      mountPath,
      containerPath: path.posix.join(COLD_BUILD_LAUNCHER_INPUT_ROOT, mountPath),
      sourceBindingHash: sourceTreeBindingEvidence.sourceBindingHash,
      sourceTreeBindingEvidence,
      sourceTreeBindingEvidenceHash: sourceTreeBindingEvidence.evidenceHash,
      hostPathIdentityHash: pathIdentityHash(hostPath),
    };
  }).sort((left, right) => left.mountPath.localeCompare(right.mountPath));
  if (normalizedReadOnlyInputTrees.some((entry, index) => (
    normalizedReadOnlyInputTrees.slice(index + 1).some((candidate) => (
      isPosixPathWithin(entry.mountPath, candidate.mountPath)
      || isPosixPathWithin(candidate.mountPath, entry.mountPath)
    ))
  ))) {
    throw new Error('cold_build_execution_plan_read_only_input_mount_overlap');
  }
  const inputSet = createColdBuildInputSet({
    sourceBindingHash,
    readOnlyInputs: normalizedReadOnlyInputTrees.map((input) => ({
      mountPath: input.mountPath,
      sourceBindingHash: input.sourceBindingHash,
    })),
  });
  const releasePath = requireHostPath(releaseHostPath, 'release_path');
  const verifiedReleaseTreeBinding = verifyColdBuildSourceTreeBindingEvidence(
    releaseTreeBindingEvidence,
    releasePath,
  );
  const releaseBindingHash = verifiedReleaseTreeBinding.sourceBindingHash;
  const specDirectory = requireHostPath(specHostDirectory, 'spec_directory');
  const launcherPath = requireHostPath(
    launcherIdentity?.executablePath,
    'launcher_path',
  );
  const protectedDirectories = [
    sourcePath,
    releasePath,
    specDirectory,
    ...normalizedReadOnlyInputTrees.map((entry) => entry.hostPath),
  ];
  const directoryPairs = protectedDirectories.flatMap((left, index) => (
    protectedDirectories.slice(index + 1).map((right) => [left, right])
  ));
  const directoryOverlap = directoryPairs.some(([left, right]) => (
    isPathWithin(left, right) || isPathWithin(right, left)
  ));
  const launcherOverlap = protectedDirectories
    .some((directoryPath) => isPathWithin(launcherPath, directoryPath));
  if (directoryOverlap || launcherOverlap) {
    throw new Error('cold_build_execution_plan_input_path_overlap');
  }
  const normalizedMemoryBytes = requireSafeInteger(memoryBytes, 'memory_bytes');
  const normalizedMemorySwapBytes = requireSafeInteger(
    memorySwapBytes,
    'memory_swap_bytes',
  );
  if (normalizedMemorySwapBytes < normalizedMemoryBytes) {
    throw new Error('cold_build_execution_plan_memory_swap_bytes_invalid');
  }
  const normalizedNanoCpus = requireSafeInteger(nanoCpus, 'nano_cpus');
  const normalizedPidsLimit = requireSafeInteger(pidsLimit, 'pids_limit', 16);
  const normalizedNofileLimit = requireSafeInteger(nofileLimit, 'nofile_limit', 64);
  const normalizedWorkspaceByteLimit = requireSafeInteger(
    workspaceByteLimit,
    'workspace_byte_limit',
  );
  const normalizedWorkspaceEntryLimit = requireSafeInteger(
    workspaceEntryLimit,
    'workspace_entry_limit',
  );
  const normalizedCollectedByteLimit = requireSafeInteger(
    collectedByteLimit,
    'collected_byte_limit',
  );
  const normalizedCollectedEntryLimit = requireSafeInteger(
    collectedEntryLimit,
    'collected_entry_limit',
  );
  const spec = coldBuildLauncherSpec({
    executionNonce,
    launcherIdentity,
    commandSpecHash,
    sourceBindingHash,
    command,
    args: normalizedArgs,
    environment: normalizedEnvironment,
    workingDirectory: normalizedWorkingDirectory,
    commandTimeoutMillis: requireSafeInteger(
      commandTimeoutMillis,
      'command_timeout_millis',
    ),
    releaseTimeoutMillis,
    workspaceByteLimit: normalizedWorkspaceByteLimit,
    workspaceEntryLimit: normalizedWorkspaceEntryLimit,
    collectedByteLimit: normalizedCollectedByteLimit,
    collectedEntryLimit: normalizedCollectedEntryLimit,
    outputManifestMode,
    declaredOutputs,
  });
  const specBytes = encodeColdBuildLauncherSpec(spec);
  const specHash = coldBuildLauncherSpecHash(spec);
  const specPath = path.join(
    specDirectory,
    `${specHash.slice('sha256:'.length)}.json`,
  );
  const labels = {
    'synthi.cold_build.command_spec_hash': commandSpecHash,
    'synthi.cold_build.execution_nonce': executionNonce,
    'synthi.cold_build.launcher_executable_hash': launcherIdentity.binaryHash,
    'synthi.cold_build.input_set_hash': inputSet.inputSetHash,
    'synthi.cold_build.release_binding_hash': releaseBindingHash,
    'synthi.cold_build.source_binding_hash': sourceBindingHash,
    'synthi.cold_build.spec_hash': specHash,
  };
  const createArgs = [
    'create',
    '--pull', 'never',
    '--name', containerName,
    '--network', 'none',
    '--read-only',
    '--privileged=false',
    '--cap-drop', 'ALL',
    ...[...COLD_BUILD_CONTAINER_CAPABILITIES]
      .sort()
      .flatMap((capability) => ['--cap-add', capability]),
    '--security-opt', 'no-new-privileges=true',
    '--pids-limit', String(normalizedPidsLimit),
    '--memory', String(normalizedMemoryBytes),
    '--memory-swap', String(normalizedMemorySwapBytes),
    '--cpus', String(normalizedNanoCpus / 1_000_000_000),
    '--ulimit', 'core=0:0',
    '--ulimit', `fsize=${normalizedWorkspaceByteLimit}:${normalizedWorkspaceByteLimit}`,
    '--ulimit', `nofile=${normalizedNofileLimit}:${normalizedNofileLimit}`,
    '--ipc', 'private',
    '--cgroupns', 'private',
    '--runtime', containerRuntime,
    '--user', '0:0',
    '--no-healthcheck',
    '--tmpfs', `/tmp:${coldBuildTmpfsOptions().join(',')}`,
    '--tmpfs', `${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}:${coldBuildOutputTmpfsOptions(
      normalizedWorkspaceByteLimit,
      normalizedWorkspaceEntryLimit,
    ).join(',')}`,
    '--tmpfs', `${COLD_BUILD_LAUNCHER_CONTROL_ROOT}:${coldBuildControlTmpfsOptions().join(',')}`,
    '--mount', dockerBindMount(sourcePath, COLD_BUILD_LAUNCHER_SOURCE_ROOT),
    ...normalizedReadOnlyInputTrees.flatMap((input) => [
      '--mount',
      dockerBindMount(input.hostPath, input.containerPath),
    ]),
    '--mount', dockerBindMount(releasePath, COLD_BUILD_LAUNCHER_RELEASE_ROOT),
    '--mount', dockerBindMount(specPath, COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH),
    '--mount', dockerBindMount(launcherPath, COLD_BUILD_LAUNCHER_CONTAINER_PATH),
    '--workdir', '/',
    '--entrypoint', coldBuildLauncherEntrypoint()[0],
    ...Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, value]) => ['--label', `${name}=${value}`]),
    workerImageId,
    ...coldBuildLauncherCommand(),
  ];
  const collectorCommand = [
    COLD_BUILD_LAUNCHER_CONTAINER_PATH,
    'collect',
    '--spec', COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
  ];
  const resourcePolicy = {
    memoryBytes: normalizedMemoryBytes,
    memorySwapBytes: normalizedMemorySwapBytes,
    nanoCpus: normalizedNanoCpus,
    pidsLimit: normalizedPidsLimit,
    nofileLimit: normalizedNofileLimit,
    workspaceByteLimit: normalizedWorkspaceByteLimit,
    workspaceEntryLimit: normalizedWorkspaceEntryLimit,
    collectedByteLimit: normalizedCollectedByteLimit,
    collectedEntryLimit: normalizedCollectedEntryLimit,
  };
  const expectedContainerConfiguration = {
    imageId: workerImageId,
    entrypoint: coldBuildLauncherEntrypoint(),
    command: coldBuildLauncherCommand(),
    user: '0:0',
    workingDirectory: '/',
    networkMode: 'none',
    readOnlyRootfs: true,
    privileged: false,
    capDrop: ['ALL'],
    capAdd: [...COLD_BUILD_CONTAINER_CAPABILITIES].sort(),
    securityOpt: ['no-new-privileges=true'],
    ipcMode: 'private',
    pidsLimit: normalizedPidsLimit,
    memoryBytes: normalizedMemoryBytes,
    memorySwapBytes: normalizedMemorySwapBytes,
    nanoCpus: normalizedNanoCpus,
    ulimits: [
      { name: 'core', soft: 0, hard: 0 },
      {
        name: 'fsize',
        soft: normalizedWorkspaceByteLimit,
        hard: normalizedWorkspaceByteLimit,
      },
      {
        name: 'nofile',
        soft: normalizedNofileLimit,
        hard: normalizedNofileLimit,
      },
    ].sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    tmpfs: {
      '/tmp': coldBuildTmpfsOptions(),
      [COLD_BUILD_LAUNCHER_OUTPUT_ROOT]: coldBuildOutputTmpfsOptions(
        normalizedWorkspaceByteLimit,
        normalizedWorkspaceEntryLimit,
      ),
      [COLD_BUILD_LAUNCHER_CONTROL_ROOT]: coldBuildControlTmpfsOptions(),
    },
    mounts: [
      [sourcePath, COLD_BUILD_LAUNCHER_SOURCE_ROOT],
      ...normalizedReadOnlyInputTrees.map((input) => [input.hostPath, input.containerPath]),
      [releasePath, COLD_BUILD_LAUNCHER_RELEASE_ROOT],
      [specPath, COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH],
      [launcherPath, COLD_BUILD_LAUNCHER_CONTAINER_PATH],
    ].map(([source, destination]) => ({
      type: 'bind',
      sourceIdentityHash: pathIdentityHash(source),
      destination,
      readWrite: false,
      propagation: 'rprivate',
    })).sort((left, right) => left.destination.localeCompare(right.destination)),
    labels,
    containerEnvironment: normalizedWorkerImageEnvironment,
    containerEnvironmentHash: contentHash(stableJson(normalizedWorkerImageEnvironment)),
    pidMode: '',
    utsMode: '',
    cgroupnsMode: 'private',
    runtime: containerRuntime,
  };
  const plan = {
    schemaVersion: COLD_BUILD_EXECUTION_PLAN_SCHEMA,
    proofAuthority: COLD_BUILD_EXECUTION_PLAN_AUTHORITY,
    executionNonce,
    commandSpecHash,
    sourceBindingHash,
    sourceTreeBindingEvidence: verifiedSourceTreeBinding,
    sourceTreeBindingEvidenceHash: verifiedSourceTreeBinding.evidenceHash,
    inputSetBindings: inputSet.entries,
    inputSetHash: inputSet.inputSetHash,
    readOnlyInputTrees: normalizedReadOnlyInputTrees,
    readOnlyInputTreesHash: contentHash(stableJson(
      normalizedReadOnlyInputTrees.map(readOnlyInputTreeProjection),
    )),
    releaseBindingHash,
    releaseTreeBindingEvidence: verifiedReleaseTreeBinding,
    releaseTreeBindingEvidenceHash: verifiedReleaseTreeBinding.evidenceHash,
    spec,
    specBytes,
    specHash,
    specByteLength: specBytes.byteLength,
    launcherIdentity,
    launcherExecutableHash: launcherIdentity.binaryHash,
    launcherBuildEvidenceHash: launcherIdentity.buildEvidence?.evidenceHash ?? null,
    workerImageId,
    workerImageOperatingSystem,
    workerImageArchitecture,
    containerName,
    containerNameHash: contentHash(containerName),
    sourceHostPath: sourcePath,
    releaseHostPath: releasePath,
    specHostPath: specPath,
    specHostDirectory: specDirectory,
    launcherHostPath: launcherPath,
    sourcePathIdentityHash: pathIdentityHash(sourcePath),
    releasePathIdentityHash: pathIdentityHash(releasePath),
    specPathIdentityHash: pathIdentityHash(specPath),
    launcherPathIdentityHash: pathIdentityHash(launcherPath),
    commandHash: contentHash(stableJson([command, ...normalizedArgs])),
    environmentHash: contentHash(stableJson(normalizedEnvironment)),
    resourcePolicy,
    expectedContainerConfiguration,
    containerCreateArgs: createArgs,
    containerCreateArgsHash: contentHash(stableJson(createArgs)),
    collectorCommand,
    collectorCommandHash: contentHash(stableJson(collectorCommand)),
    readyReceiptRequired: true,
    canAuthorizeLauncherExecution: false,
    planValid: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  const projection = executionPlanProjection(plan);
  plan.planHash = contentHash(stableJson(projection));
  PINNED_EXECUTION_PLANS.set(plan, Object.freeze({
    projectionHash: plan.planHash,
    launcherIdentity,
  }));
  INPUT_OBSERVATION_SEQUENCE.set(plan, 0);
  return plan;
}

export async function publishColdBuildLauncherSpec(plan) {
  const pinnedPlan = PINNED_EXECUTION_PLANS.get(plan);
  if (
    !pinnedPlan
    || pinnedPlan.launcherIdentity !== plan?.launcherIdentity
    || pinnedPlan.projectionHash !== plan?.planHash
    || contentHash(stableJson(executionPlanProjection(plan))) !== plan.planHash
    || !executionPlanMaterialAccepted(plan)
  ) {
    throw new Error('cold_build_execution_plan_identity_invalid');
  }
  if (PINNED_SPEC_PUBLICATIONS.has(plan)) {
    throw new Error('cold_build_spec_already_published');
  }
  const parent = await inspectExecutionInput(plan.specHostDirectory, 'directory');
  const parentPrivate = process.platform === 'win32'
    ? null
    : (parent.metadata.mode & 0o077) === 0;
  const parentOwnerAccepted = process.platform === 'win32'
    ? null
    : typeof process.getuid === 'function'
      && parent.metadata.ownerUserId === String(process.getuid());
  if (!parent.accepted || parentPrivate === false || parentOwnerAccepted === false) {
    throw new Error('cold_build_spec_publication_parent_untrusted');
  }
  let handle = null;
  let created = false;
  let published = false;
  try {
    handle = await open(plan.specHostPath, 'wx', 0o400);
    created = true;
    await handle.writeFile(plan.specBytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(plan.specHostPath, 0o444);
    published = true;
  } catch (error) {
    if (!created && error?.code === 'EEXIST') {
      throw new Error('cold_build_spec_content_address_collision');
    }
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (created && !published) await unlink(plan.specHostPath).catch(() => {});
  }
  const spec = await inspectExecutionInput(plan.specHostPath, 'file', plan.specHash);
  if (!spec.accepted) {
    await unlink(plan.specHostPath).catch(() => {});
    throw new Error('cold_build_spec_publication_verification_failed');
  }
  const publication = {
    schemaVersion: COLD_BUILD_SPEC_PUBLICATION_SCHEMA,
    proofAuthority: COLD_BUILD_SPEC_PUBLICATION_AUTHORITY,
    planHash: plan.planHash,
    specHash: plan.specHash,
    specByteLength: plan.specByteLength,
    specPathIdentityHash: plan.specPathIdentityHash,
    specMetadataHash: spec.metadataHash,
    parentMetadataHash: parent.metadataHash,
    exclusiveCreateUsed: true,
    contentAddressedName: path.basename(plan.specHostPath),
    parentPrivate,
    parentOwnerAccepted,
    permissionLimitation: process.platform === 'win32'
      ? 'windows_acl_not_recomputed_runtime_spec_hash_required'
      : null,
    published: true,
    readyReceiptRequired: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  publication.evidenceHash = contentHash(stableJson(publication));
  PINNED_SPEC_PUBLICATIONS.set(plan, Object.freeze({
    publication,
    evidenceHash: publication.evidenceHash,
    specMetadataHash: publication.specMetadataHash,
  }));
  return publication;
}

export async function verifyColdBuildLauncherExecutionInputs(plan, {
  phase,
  expectedContainerId = null,
} = {}) {
  const pinnedPlan = PINNED_EXECUTION_PLANS.get(plan);
  if (
    !pinnedPlan
    || pinnedPlan.launcherIdentity !== plan?.launcherIdentity
    || pinnedPlan.projectionHash !== plan?.planHash
    || contentHash(stableJson(executionPlanProjection(plan))) !== plan.planHash
    || !executionPlanMaterialAccepted(plan)
  ) {
    throw new Error('cold_build_execution_plan_identity_invalid');
  }
  if (!['before_create', 'after_create', 'after_collection'].includes(phase)) {
    throw new Error('cold_build_execution_input_phase_invalid');
  }
  const boundContainerId = phase === 'before_create'
    ? null
    : requireContainerId(expectedContainerId);
  if (phase === 'before_create' && expectedContainerId != null) {
    throw new Error('cold_build_execution_input_container_id_unexpected');
  }
  const pinnedPublication = PINNED_SPEC_PUBLICATIONS.get(plan);
  if (
    !pinnedPublication
    || pinnedPublication.publication?.published !== true
    || pinnedPublication.publication?.proofAuthority
      !== COLD_BUILD_SPEC_PUBLICATION_AUTHORITY
    || pinnedPublication.publication?.acceptedForGpuHmr !== false
    || pinnedPublication.publication?.gpuHmrSuccess !== false
    || pinnedPublication.evidenceHash !== pinnedPublication.publication.evidenceHash
    || recomputeEvidenceHash(pinnedPublication.publication)
      !== pinnedPublication.evidenceHash
  ) {
    throw new Error('cold_build_spec_publication_evidence_invalid');
  }
  const [
    source,
    release,
    spec,
    launcher,
    specParent,
    sourceTreeBinding,
    releaseTreeBinding,
  ] = await Promise.all([
    inspectExecutionInput(plan.sourceHostPath, 'directory'),
    inspectExecutionInput(plan.releaseHostPath, 'directory'),
    inspectExecutionInput(plan.specHostPath, 'file', plan.specHash),
    inspectExecutionInput(
      plan.launcherHostPath,
      'file',
      plan.launcherExecutableHash,
    ),
    inspectExecutionInput(path.dirname(plan.specHostPath), 'directory'),
    computeColdBuildSourceTreeBinding(plan.sourceHostPath, {
      maxEntryCount: plan.sourceTreeBindingEvidence.maxEntryCount,
      maxByteLength: plan.sourceTreeBindingEvidence.maxByteLength,
    }),
    computeColdBuildSourceTreeBinding(plan.releaseHostPath, {
      maxEntryCount: plan.releaseTreeBindingEvidence.maxEntryCount,
      maxByteLength: plan.releaseTreeBindingEvidence.maxByteLength,
    }),
  ]);
  const readOnlyInputs = await Promise.all(plan.readOnlyInputTrees.map(async (input) => {
    const [pathObservation, sourceTreeBinding] = await Promise.all([
      inspectExecutionInput(input.hostPath, 'directory'),
      computeColdBuildSourceTreeBinding(input.hostPath, {
        maxEntryCount: input.sourceTreeBindingEvidence.maxEntryCount,
        maxByteLength: input.sourceTreeBindingEvidence.maxByteLength,
      }),
    ]);
    return {
      mountPath: input.mountPath,
      containerPath: input.containerPath,
      sourceBindingHash: input.sourceBindingHash,
      path: pathObservation,
      sourceTreeBinding,
    };
  }));
  const specParentPrivate = process.platform === 'win32'
    ? null
    : (specParent.metadata.mode & 0o077) === 0;
  const specParentOwnerAccepted = process.platform === 'win32'
    ? null
    : typeof process.getuid === 'function'
      && specParent.metadata.ownerUserId === String(process.getuid());
  const specImmutableMode = process.platform === 'win32'
    ? null
    : (spec.metadata.mode & 0o222) === 0;
  const launcherImmutableMode = process.platform === 'win32'
    ? null
    : (launcher.metadata.mode & 0o222) === 0;
  const blockingGaps = [];
  for (const [name, observation] of Object.entries({
    source,
    release,
    spec,
    launcher,
    spec_parent: specParent,
  })) {
    if (!observation.accepted) {
      blockingGaps.push(`cold_build_execution_input_${name}_invalid`);
    }
  }
  for (let index = 0; index < readOnlyInputs.length; index += 1) {
    const input = readOnlyInputs[index];
    if (!input.path.accepted) {
      blockingGaps.push(`cold_build_execution_input_read_only_${index}_invalid`);
    }
    if (input.sourceTreeBinding.sourceBindingHash !== input.sourceBindingHash) {
      blockingGaps.push(`cold_build_execution_input_read_only_${index}_binding_mismatch`);
    }
  }
  if (specParentPrivate === false) {
    blockingGaps.push('cold_build_execution_input_spec_parent_not_private');
  }
  if (specParentOwnerAccepted === false) {
    blockingGaps.push('cold_build_execution_input_spec_parent_owner_mismatch');
  }
  if (specImmutableMode === false) {
    blockingGaps.push('cold_build_execution_input_spec_mutable');
  }
  if (launcherImmutableMode === false) {
    blockingGaps.push('cold_build_execution_input_launcher_mutable');
  }
  if (spec.metadataHash !== pinnedPublication.specMetadataHash) {
    blockingGaps.push('cold_build_execution_input_spec_identity_changed');
  }
  if (sourceTreeBinding.sourceBindingHash !== plan.sourceBindingHash) {
    blockingGaps.push('cold_build_execution_input_source_binding_mismatch');
  }
  const observedInputSet = createColdBuildInputSet({
    sourceBindingHash: sourceTreeBinding.sourceBindingHash,
    readOnlyInputs: readOnlyInputs.map((input) => ({
      mountPath: input.mountPath,
      sourceBindingHash: input.sourceTreeBinding.sourceBindingHash,
    })),
  });
  if (observedInputSet.inputSetHash !== plan.inputSetHash) {
    blockingGaps.push('cold_build_execution_input_set_binding_mismatch');
  }
  if (releaseTreeBinding.sourceBindingHash !== plan.releaseBindingHash) {
    blockingGaps.push('cold_build_execution_input_release_binding_mismatch');
  }
  const inputs = {
    source,
    release,
    spec,
    launcher,
    specParent,
    sourceTreeBinding,
    readOnlyInputs,
    inputSetBindings: observedInputSet.entries,
    releaseTreeBinding,
  };
  const observationSequence = (INPUT_OBSERVATION_SEQUENCE.get(plan) ?? 0) + 1;
  INPUT_OBSERVATION_SEQUENCE.set(plan, observationSequence);
  const evidence = {
    schemaVersion: COLD_BUILD_EXECUTION_INPUTS_SCHEMA,
    proofAuthority: COLD_BUILD_EXECUTION_INPUTS_AUTHORITY,
    planHash: plan.planHash,
    executionNonce: plan.executionNonce,
    specHash: plan.specHash,
    launcherExecutableHash: plan.launcherExecutableHash,
    sourceBindingHash: plan.sourceBindingHash,
    inputSetHash: plan.inputSetHash,
    observedInputSetHash: observedInputSet.inputSetHash,
    readOnlyInputTreesHash: plan.readOnlyInputTreesHash,
    releaseBindingHash: plan.releaseBindingHash,
    phase,
    expectedContainerId: boundContainerId,
    observationSequence,
    specPublicationEvidenceHash: pinnedPublication.evidenceHash,
    inputs,
    inputsHash: contentHash(stableJson(inputs)),
    specParentPrivate,
    specParentOwnerAccepted,
    specImmutableMode,
    launcherImmutableMode,
    specParentPermissionLimitation: process.platform === 'win32'
      ? 'windows_acl_not_recomputed_runtime_spec_hash_required'
      : null,
    acceptedAsExecutionInputEvidence: blockingGaps.length === 0,
    blockingGaps: [...new Set(blockingGaps)].sort(),
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = contentHash(stableJson(evidence));
  PINNED_INPUT_EVIDENCE.set(evidence, Object.freeze({
    plan,
    evidenceHash: evidence.evidenceHash,
    inputsHash: evidence.inputsHash,
    phase,
    expectedContainerId: boundContainerId,
    observationSequence,
  }));
  return evidence;
}

function requireExecutionInputEvidence(evidence, plan, {
  phase,
  expectedContainerId,
} = {}) {
  const pinned = PINNED_INPUT_EVIDENCE.get(evidence);
  if (
    !pinned
    || pinned.plan !== plan
    || pinned.evidenceHash !== evidence?.evidenceHash
    || pinned.inputsHash !== evidence?.inputsHash
    || pinned.phase !== phase
    || pinned.expectedContainerId !== expectedContainerId
    || pinned.observationSequence !== evidence?.observationSequence
    || contentHash(stableJson(evidence?.inputs)) !== evidence?.inputsHash
    || recomputeEvidenceHash(evidence) !== evidence?.evidenceHash
    || evidence?.schemaVersion !== COLD_BUILD_EXECUTION_INPUTS_SCHEMA
    || evidence?.proofAuthority !== COLD_BUILD_EXECUTION_INPUTS_AUTHORITY
    || evidence?.planHash !== plan.planHash
    || evidence?.inputSetHash !== plan.inputSetHash
    || evidence?.observedInputSetHash !== plan.inputSetHash
    || evidence?.phase !== phase
    || evidence?.expectedContainerId !== expectedContainerId
    || evidence?.acceptedAsExecutionInputEvidence !== true
    || !Array.isArray(evidence?.blockingGaps)
    || evidence.blockingGaps.length !== 0
    || evidence?.acceptedForGpuHmr !== false
    || evidence?.gpuHmrSuccess !== false
    || evidence?.canSatisfyRuntimeProof !== false
    || evidence?.canSatisfyDispatchProof !== false
  ) {
    throw new Error('cold_build_execution_input_evidence_invalid');
  }
  return evidence;
}

export function coldBuildLauncherCollectorExecArgs(plan, containerId) {
  const pinnedPlan = PINNED_EXECUTION_PLANS.get(plan);
  if (
    !pinnedPlan
    || pinnedPlan.projectionHash !== plan?.planHash
    || !executionPlanMaterialAccepted(plan)
  ) {
    throw new Error('cold_build_execution_plan_identity_invalid');
  }
  return [
    'exec',
    '--user', '0:0',
    requireContainerId(containerId),
    ...plan.collectorCommand,
  ];
}

export function verifyColdBuildLauncherContainerInspection(inspectInput, plan, {
  expectedContainerId,
  inputEvidenceBeforeCreate,
  inputEvidenceAfterCreate,
} = {}) {
  const pinnedPlan = PINNED_EXECUTION_PLANS.get(plan);
  if (
    !pinnedPlan
    || pinnedPlan.launcherIdentity !== plan?.launcherIdentity
    || pinnedPlan.projectionHash !== plan?.planHash
    || contentHash(stableJson(executionPlanProjection(plan))) !== plan.planHash
    || !executionPlanMaterialAccepted(plan)
  ) {
    throw new Error('cold_build_execution_plan_identity_invalid');
  }
  if (inputEvidenceBeforeCreate === inputEvidenceAfterCreate) {
    throw new Error('cold_build_execution_input_observation_reused');
  }
  const containerId = requireContainerId(expectedContainerId);
  const beforeInputs = requireExecutionInputEvidence(inputEvidenceBeforeCreate, plan, {
    phase: 'before_create',
    expectedContainerId: null,
  });
  const afterInputs = requireExecutionInputEvidence(inputEvidenceAfterCreate, plan, {
    phase: 'after_create',
    expectedContainerId: containerId,
  });
  if (
    !Number.isSafeInteger(beforeInputs.observationSequence)
    || !Number.isSafeInteger(afterInputs.observationSequence)
    || afterInputs.observationSequence <= beforeInputs.observationSequence
  ) {
    throw new Error('cold_build_execution_input_observation_order_invalid');
  }
  if (beforeInputs.inputsHash !== afterInputs.inputsHash) {
    throw new Error('cold_build_execution_input_identity_changed');
  }
  if (!Array.isArray(inspectInput) || inspectInput.length !== 1) {
    throw new Error('cold_build_container_inspection_cardinality_invalid');
  }
  const [inspect] = inspectInput;
  if (!inspect || typeof inspect !== 'object' || Array.isArray(inspect)) {
    throw new Error('cold_build_container_inspection_shape_invalid');
  }
  const config = inspect.Config ?? {};
  const host = inspect.HostConfig ?? {};
  const expected = plan.expectedContainerConfiguration;
  const observedTmpfs = Object.fromEntries(
    Object.entries(host.Tmpfs ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([target, options]) => [target, normalizeTmpfsOptions(options)]),
  );
  const observedLabels = config.Labels && typeof config.Labels === 'object'
    ? config.Labels
    : {};
  const observedReservedLabels = Object.fromEntries(
    Object.keys(expected.labels)
      .sort()
      .map((name) => [name, observedLabels[name] ?? null]),
  );
  const projection = {
    containerId: String(inspect.Id ?? ''),
    containerIdHash: typeof inspect.Id === 'string' && inspect.Id.length > 0
      ? contentHash(inspect.Id)
      : null,
    containerName: String(inspect.Name ?? ''),
    imageId: String(inspect.Image ?? config.Image ?? ''),
    entrypoint: normalizeStringArray(config.Entrypoint),
    command: normalizeStringArray(config.Cmd),
    user: String(config.User ?? ''),
    workingDirectory: String(config.WorkingDir ?? ''),
    networkMode: String(host.NetworkMode ?? ''),
    readOnlyRootfs: host.ReadonlyRootfs === true,
    privileged: host.Privileged === true,
    capDrop: normalizeCapabilities(host.CapDrop),
    capAdd: normalizeCapabilities(host.CapAdd),
    securityOpt: normalizeSecurityOptions(host.SecurityOpt),
    ipcMode: String(host.IpcMode ?? ''),
    pidsLimit: Number(host.PidsLimit),
    memoryBytes: Number(host.Memory),
    memorySwapBytes: Number(host.MemorySwap),
    nanoCpus: Number(host.NanoCpus),
    ulimits: normalizeUlimits(host.Ulimits),
    tmpfs: observedTmpfs,
    mounts: normalizeMounts(inspect.Mounts),
    labels: observedReservedLabels,
    containerEnvironment: normalizeStringArray(config.Env).sort(),
    containerEnvironmentHash: contentHash(stableJson(
      normalizeStringArray(config.Env).sort(),
    )),
    autoRemove: host.AutoRemove === true,
    usernsMode: String(host.UsernsMode ?? ''),
    pidMode: String(host.PidMode ?? ''),
    utsMode: String(host.UTSMode ?? ''),
    cgroupnsMode: String(host.CgroupnsMode ?? ''),
    runtime: String(host.Runtime ?? ''),
    groupAdd: normalizeStringArray(host.GroupAdd).sort(),
    deviceCgroupRules: normalizeStringArray(host.DeviceCgroupRules).sort(),
    dns: normalizeStringArray(host.Dns).sort(),
    dnsOptions: normalizeStringArray(host.DnsOptions).sort(),
    dnsSearch: normalizeStringArray(host.DnsSearch).sort(),
    extraHosts: normalizeStringArray(host.ExtraHosts).sort(),
    links: normalizeStringArray(host.Links).sort(),
    volumesFrom: normalizeStringArray(host.VolumesFrom).sort(),
    sysctls: host.Sysctls && typeof host.Sysctls === 'object'
      ? Object.fromEntries(Object.entries(host.Sysctls).sort(([left], [right]) => (
        left.localeCompare(right)
      )))
      : {},
    portBindingCount: host.PortBindings && typeof host.PortBindings === 'object'
      ? Object.keys(host.PortBindings).length
      : 0,
    publishAllPorts: host.PublishAllPorts === true,
    cgroupParent: String(host.CgroupParent ?? ''),
    isolation: String(host.Isolation ?? ''),
    supplementaryGroupCount: Array.isArray(host.GroupAdd) ? host.GroupAdd.length : 0,
    deviceCount: Array.isArray(host.Devices) ? host.Devices.length : 0,
    deviceRequestCount: Array.isArray(host.DeviceRequests) ? host.DeviceRequests.length : 0,
    declaredVolumeCount: config.Volumes && typeof config.Volumes === 'object'
      ? Object.keys(config.Volumes).length
      : 0,
    restartPolicy: String(host.RestartPolicy?.Name ?? ''),
    healthcheckDisabled: Array.isArray(config.Healthcheck?.Test)
      && config.Healthcheck.Test.length === 1
      && config.Healthcheck.Test[0] === 'NONE',
    openStdin: config.OpenStdin === true,
    stdinOnce: config.StdinOnce === true,
    tty: config.Tty === true,
  };
  const blockingGaps = [];
  const requireEqual = (name, actual, expectedValue) => {
    if (stableJson(actual) !== stableJson(expectedValue)) {
      blockingGaps.push(`cold_build_container_${name}_mismatch`);
    }
  };
  requireEqual('id', projection.containerId, containerId);
  requireEqual('name', projection.containerName, `/${plan.containerName}`);
  requireEqual('image', projection.imageId, expected.imageId);
  requireEqual('entrypoint', projection.entrypoint, expected.entrypoint);
  requireEqual('command', projection.command, expected.command);
  requireEqual('user', projection.user, expected.user);
  requireEqual('working_directory', projection.workingDirectory, expected.workingDirectory);
  requireEqual('network_mode', projection.networkMode, expected.networkMode);
  requireEqual('read_only_rootfs', projection.readOnlyRootfs, expected.readOnlyRootfs);
  requireEqual('privileged', projection.privileged, expected.privileged);
  requireEqual('cap_drop', projection.capDrop, expected.capDrop);
  requireEqual('cap_add', projection.capAdd, expected.capAdd);
  requireEqual('security_opt', projection.securityOpt, expected.securityOpt);
  requireEqual('ipc_mode', projection.ipcMode, expected.ipcMode);
  requireEqual('pids_limit', projection.pidsLimit, expected.pidsLimit);
  requireEqual('memory', projection.memoryBytes, expected.memoryBytes);
  requireEqual('memory_swap', projection.memorySwapBytes, expected.memorySwapBytes);
  requireEqual('nano_cpus', projection.nanoCpus, expected.nanoCpus);
  requireEqual('ulimits', projection.ulimits, expected.ulimits);
  requireEqual('tmpfs', projection.tmpfs, expected.tmpfs);
  requireEqual('mounts', projection.mounts, expected.mounts);
  requireEqual('labels', projection.labels, expected.labels);
  requireEqual(
    'environment',
    projection.containerEnvironment,
    expected.containerEnvironment,
  );
  requireEqual(
    'environment_hash',
    projection.containerEnvironmentHash,
    expected.containerEnvironmentHash,
  );
  requireEqual('auto_remove', projection.autoRemove, false);
  requireEqual('userns_mode', projection.usernsMode, '');
  requireEqual('pid_mode', projection.pidMode, expected.pidMode);
  requireEqual('uts_mode', projection.utsMode, expected.utsMode);
  requireEqual('cgroupns_mode', projection.cgroupnsMode, expected.cgroupnsMode);
  requireEqual('runtime', projection.runtime, expected.runtime);
  requireEqual('group_add', projection.groupAdd, []);
  requireEqual('device_cgroup_rules', projection.deviceCgroupRules, []);
  requireEqual('dns', projection.dns, []);
  requireEqual('dns_options', projection.dnsOptions, []);
  requireEqual('dns_search', projection.dnsSearch, []);
  requireEqual('extra_hosts', projection.extraHosts, []);
  requireEqual('links', projection.links, []);
  requireEqual('volumes_from', projection.volumesFrom, []);
  requireEqual('sysctls', projection.sysctls, {});
  requireEqual('port_binding_count', projection.portBindingCount, 0);
  requireEqual('publish_all_ports', projection.publishAllPorts, false);
  requireEqual('cgroup_parent', projection.cgroupParent, '');
  requireEqual('isolation', projection.isolation, '');
  requireEqual('supplementary_group_count', projection.supplementaryGroupCount, 0);
  requireEqual('device_count', projection.deviceCount, 0);
  requireEqual('device_request_count', projection.deviceRequestCount, 0);
  requireEqual('declared_volume_count', projection.declaredVolumeCount, 0);
  requireEqual('restart_policy', projection.restartPolicy, 'no');
  requireEqual('healthcheck_disabled', projection.healthcheckDisabled, true);
  requireEqual('open_stdin', projection.openStdin, false);
  requireEqual('stdin_once', projection.stdinOnce, false);
  requireEqual('tty', projection.tty, false);
  const canonicalGaps = [...new Set(blockingGaps)].sort();
  const evidence = {
    schemaVersion: COLD_BUILD_CONTAINER_INSPECTION_SCHEMA,
    proofAuthority: COLD_BUILD_CONTAINER_INSPECTION_AUTHORITY,
    planHash: plan.planHash,
    executionNonce: plan.executionNonce,
    commandSpecHash: plan.commandSpecHash,
    sourceBindingHash: plan.sourceBindingHash,
    inputSetHash: plan.inputSetHash,
    releaseBindingHash: plan.releaseBindingHash,
    specHash: plan.specHash,
    launcherExecutableHash: plan.launcherExecutableHash,
    inputEvidenceBeforeCreateHash: beforeInputs.evidenceHash,
    inputEvidenceAfterCreateHash: afterInputs.evidenceHash,
    executionInputsHash: beforeInputs.inputsHash,
    readyReceiptRequired: true,
    canAuthorizeLauncherExecution: false,
    observedConfiguration: projection,
    observedConfigurationHash: contentHash(stableJson(projection)),
    configurationMatchesPlan: canonicalGaps.length === 0,
    acceptedAsContainerInspectionEvidence: canonicalGaps.length === 0,
    blockingGaps: canonicalGaps,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = contentHash(stableJson(evidence));
  return evidence;
}
