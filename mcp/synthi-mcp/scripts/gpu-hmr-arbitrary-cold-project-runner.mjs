import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateArtifactCasManifest,
  writeArtifactToCas,
} from './lib/gpu-hmr-artifact-cas.mjs';
import {
  createArbitraryColdProjectContract,
  verifyArbitraryColdProjectContract,
} from './lib/gpu-hmr-arbitrary-cold-project-contract.mjs';
import {
  COLD_BUILD_LAUNCHER_SOURCE_ROOT,
  materializeColdBuildLauncher,
} from './lib/gpu-hmr-cold-build-container-contract.mjs';
import {
  executeColdBuildLauncherPlan,
  verifyColdBuildExecutionDriverResult,
} from './lib/gpu-hmr-cold-build-execution-driver.mjs';
import { createColdBuildLauncherExecutionPlan } from './lib/gpu-hmr-cold-build-execution-plan.mjs';
import {
  deriveColdBuildOutputEvidence,
  verifyColdBuildOutputEvidence,
} from './lib/gpu-hmr-cold-build-output-evidence.mjs';
import {
  computeColdBuildSourceTreeBinding,
  verifyColdBuildSourceTreeBindingEvidence,
} from './lib/gpu-hmr-cold-build-source-tree-binding.mjs';
import {
  inspectImmutableColdBuildWorkerImage,
  verifyImmutableColdBuildWorkerImage,
} from './lib/gpu-hmr-cold-build-worker-image.mjs';

export const ARBITRARY_COLD_PROJECT_DESCRIPTOR_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_descriptor.v1';
export const ARBITRARY_COLD_PROJECT_RUN_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_run.v1';
export const ARBITRARY_COLD_PROJECT_RUN_AUTHORITY =
  'orchestrated_cold_build_evidence_only_not_gpu_hmr_success';

export const DEFAULT_ARBITRARY_COLD_RUNNER_POLICY = Object.freeze({
  maxSourceEntryCount: 1_000_000,
  maxSourceByteLength: 64 * 1024 * 1024 * 1024,
  maxWorkspaceEntryCount: 1_000_000,
  maxWorkspaceByteLength: 64 * 1024 * 1024 * 1024,
  maxCollectedEntryCount: 100_000,
  maxCollectedByteLength: 8 * 1024 * 1024 * 1024,
  maxCommandTimeoutMillis: 2 * 60 * 60 * 1000,
  maxReleaseTimeoutMillis: 10 * 60 * 1000,
  maxMemoryBytes: 128 * 1024 * 1024 * 1024,
  maxMemorySwapBytes: 128 * 1024 * 1024 * 1024,
  maxNanoCpus: 128_000_000_000,
  maxPidsLimit: 65_536,
  maxNofileLimit: 1_048_576,
});

const PINNED_RUNS = new WeakMap();
const DESCRIPTOR_KEYS = [
  'schemaVersion',
  'sourceRoot',
  'workerImage',
  'containerRuntime',
  'command',
  'args',
  'environment',
  'workingDirectory',
  'outputs',
  'sourceLimits',
  'resources',
];
const POLICY_KEYS = Object.keys(DEFAULT_ARBITRARY_COLD_RUNNER_POLICY).sort();

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

function cloneDescriptorValue(value, seen = new WeakSet()) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw new Error('arbitrary_cold_runner_descriptor_value_invalid');
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error('arbitrary_cold_runner_descriptor_value_invalid');
  }
  seen.add(value);
  const copy = Array.isArray(value)
    ? value.map((item) => cloneDescriptorValue(item, seen))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      cloneDescriptorValue(item, seen),
    ]));
  seen.delete(value);
  return Object.freeze(copy);
}

function requireSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`arbitrary_cold_runner_${name}_invalid`);
  }
  return value;
}

function requireHostPath(value, name) {
  if (typeof value !== 'string' || value.length < 1 || /[\0\r\n]/.test(value)) {
    throw new Error(`arbitrary_cold_runner_${name}_invalid`);
  }
  return path.resolve(value);
}

function pathIdentityHash(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return contentHash(process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizePolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('arbitrary_cold_runner_policy_invalid');
  }
  const unknownKeys = Object.keys(value).filter((key) => !POLICY_KEYS.includes(key));
  if (unknownKeys.length !== 0) {
    throw new Error('arbitrary_cold_runner_policy_invalid');
  }
  return Object.fromEntries(POLICY_KEYS.map((key) => [
    key,
    requireSafeInteger(
      value[key] ?? DEFAULT_ARBITRARY_COLD_RUNNER_POLICY[key],
      `policy_${key}`,
    ),
  ]));
}

function normalizeSourceLimits(value, policy) {
  if (!exactKeys(value, ['maxEntryCount', 'maxByteLength'])) {
    throw new Error('arbitrary_cold_runner_source_limits_invalid');
  }
  const limits = {
    maxEntryCount: requireSafeInteger(value.maxEntryCount, 'source_entry_limit'),
    maxByteLength: requireSafeInteger(value.maxByteLength, 'source_byte_limit'),
  };
  if (
    limits.maxEntryCount > policy.maxSourceEntryCount
    || limits.maxByteLength > policy.maxSourceByteLength
  ) {
    throw new Error('arbitrary_cold_runner_source_limits_exceed_policy');
  }
  return limits;
}

function enforceResourcePolicy(resources, policy) {
  const checks = [
    ['commandTimeoutMillis', 'maxCommandTimeoutMillis'],
    ['releaseTimeoutMillis', 'maxReleaseTimeoutMillis'],
    ['workspaceEntryLimit', 'maxWorkspaceEntryCount'],
    ['workspaceByteLimit', 'maxWorkspaceByteLength'],
    ['collectedEntryLimit', 'maxCollectedEntryCount'],
    ['collectedByteLimit', 'maxCollectedByteLength'],
    ['memoryBytes', 'maxMemoryBytes'],
    ['memorySwapBytes', 'maxMemorySwapBytes'],
    ['nanoCpus', 'maxNanoCpus'],
    ['pidsLimit', 'maxPidsLimit'],
    ['nofileLimit', 'maxNofileLimit'],
  ];
  if (checks.some(([resourceName, policyName]) => (
    !Number.isSafeInteger(resources?.[resourceName])
    || resources[resourceName] > policy[policyName]
  ))) {
    throw new Error('arbitrary_cold_runner_resources_exceed_policy');
  }
}

export function normalizeArbitraryColdProjectDescriptor(input, { policy = {} } = {}) {
  if (!exactKeys(input, DESCRIPTOR_KEYS)) {
    throw new Error('arbitrary_cold_runner_descriptor_shape_invalid');
  }
  const copiedInput = cloneDescriptorValue(input);
  if (copiedInput.schemaVersion !== ARBITRARY_COLD_PROJECT_DESCRIPTOR_SCHEMA) {
    throw new Error('arbitrary_cold_runner_descriptor_schema_invalid');
  }
  const normalizedPolicy = normalizePolicy(policy);
  const sourceLimits = Object.freeze(normalizeSourceLimits(
    copiedInput.sourceLimits,
    normalizedPolicy,
  ));
  const sourceRoot = requireHostPath(copiedInput.sourceRoot, 'source_root');
  if (
    typeof copiedInput.workerImage !== 'string'
    || copiedInput.workerImage.length < 1
    || copiedInput.workerImage.length > 2048
  ) {
    throw new Error('arbitrary_cold_runner_worker_image_invalid');
  }
  if (
    !copiedInput.resources
    || typeof copiedInput.resources !== 'object'
    || Array.isArray(copiedInput.resources)
  ) {
    throw new Error('arbitrary_cold_runner_resources_invalid');
  }
  enforceResourcePolicy(copiedInput.resources, normalizedPolicy);
  return Object.freeze({
    schemaVersion: ARBITRARY_COLD_PROJECT_DESCRIPTOR_SCHEMA,
    sourceRoot,
    workerImage: copiedInput.workerImage,
    containerRuntime: copiedInput.containerRuntime,
    command: copiedInput.command,
    args: copiedInput.args,
    environment: copiedInput.environment,
    workingDirectory: copiedInput.workingDirectory,
    outputs: copiedInput.outputs,
    sourceLimits,
    resources: copiedInput.resources,
  });
}

function contractOutputDeclarations(contract) {
  return contract.outputs.map(({ metadataAuthority: _metadataAuthority, ...output }) => output);
}

function outputContractProjection(contract) {
  return contract.outputs.map((output) => ({
    path: output.path,
    declaredRole: output.role,
    declaredArtifactKind: output.artifactKind,
    declaredMediaType: output.mediaType,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
}

function observedOutputContractProjection(outputEvidence) {
  return outputEvidence.evidence.outputs.map((output) => ({
    path: output.path,
    declaredRole: output.declaredRole,
    declaredArtifactKind: output.declaredArtifactKind,
    declaredMediaType: output.declaredMediaType,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
}

function mapWorkingDirectory(relativePath) {
  return relativePath === '.'
    ? COLD_BUILD_LAUNCHER_SOURCE_ROOT
    : path.posix.join(COLD_BUILD_LAUNCHER_SOURCE_ROOT, relativePath);
}

async function createPrivateOrchestrationRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-arbitrary-cold-run-'));
  const releaseHostPath = path.join(root, 'release');
  const specHostDirectory = path.join(root, 'specs');
  await Promise.all([
    mkdir(releaseHostPath, { recursive: false }),
    mkdir(specHostDirectory, { recursive: false }),
  ]);
  await Promise.all([
    chmod(releaseHostPath, 0o700),
    chmod(specHostDirectory, 0o700),
  ]);
  return { root, releaseHostPath, specHostDirectory };
}

async function removePrivateOrchestrationRoot(root) {
  if (!root) return;
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  const relative = path.relative(temporaryRoot, resolved);
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
    || !path.basename(resolved).startsWith('synthi-arbitrary-cold-run-')
  ) {
    throw new Error('arbitrary_cold_runner_temporary_root_refused');
  }
  await rm(resolved, { recursive: true, force: true });
}

async function observeDirectoryIdentity(directory, errorCode) {
  try {
    const [metadata, canonicalPath] = await Promise.all([
      lstat(directory, { bigint: true }),
      realpath(directory),
    ]);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(errorCode);
    }
    return Object.freeze({
      canonicalPath,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
    });
  } catch {
    throw new Error(errorCode);
  }
}

async function verifyDirectoryIdentity(identity, errorCode) {
  const observed = await observeDirectoryIdentity(identity.canonicalPath, errorCode);
  if (
    comparablePath(observed.canonicalPath) !== comparablePath(identity.canonicalPath)
    || observed.device !== identity.device
    || observed.inode !== identity.inode
  ) {
    throw new Error(errorCode);
  }
  return observed;
}

async function inspectArtifactRoot(artifactRoot, sourceRoot) {
  const requested = requireHostPath(artifactRoot, 'artifact_root');
  const [identity, canonicalSource] = await Promise.all([
    observeDirectoryIdentity(requested, 'arbitrary_cold_runner_artifact_root_invalid'),
    realpath(sourceRoot),
  ]);
  if (comparablePath(identity.canonicalPath) !== comparablePath(requested)) {
    throw new Error('arbitrary_cold_runner_artifact_root_invalid');
  }
  if (
    sameOrInside(identity.canonicalPath, canonicalSource)
    || sameOrInside(canonicalSource, identity.canonicalPath)
  ) {
    throw new Error('arbitrary_cold_runner_artifact_source_overlap');
  }
  return identity;
}

async function createArtifactSessionRoot(artifactRootIdentity) {
  await verifyDirectoryIdentity(
    artifactRootIdentity,
    'arbitrary_cold_runner_artifact_root_identity_changed',
  );
  const requestedSessionPath = await mkdtemp(path.join(
    artifactRootIdentity.canonicalPath,
    'cold-run-',
  ));
  const sessionIdentity = await observeDirectoryIdentity(
    requestedSessionPath,
    'arbitrary_cold_runner_artifact_session_invalid',
  );
  await verifyDirectoryIdentity(
    artifactRootIdentity,
    'arbitrary_cold_runner_artifact_root_identity_changed',
  );
  if (
    comparablePath(requestedSessionPath) !== comparablePath(sessionIdentity.canonicalPath)
    || comparablePath(path.dirname(sessionIdentity.canonicalPath))
      !== comparablePath(artifactRootIdentity.canonicalPath)
  ) {
    throw new Error('arbitrary_cold_runner_artifact_session_invalid');
  }
  return Object.freeze({
    ...sessionIdentity,
    parent: artifactRootIdentity,
  });
}

async function verifyArtifactSessionRoot(sessionIdentity) {
  await verifyDirectoryIdentity(
    sessionIdentity.parent,
    'arbitrary_cold_runner_artifact_root_identity_changed',
  );
  await verifyDirectoryIdentity(
    sessionIdentity,
    'arbitrary_cold_runner_artifact_session_identity_changed',
  );
  if (
    comparablePath(path.dirname(sessionIdentity.canonicalPath))
    !== comparablePath(sessionIdentity.parent.canonicalPath)
  ) {
    throw new Error('arbitrary_cold_runner_artifact_session_identity_changed');
  }
}

async function persistOutputs(outputEvidence, artifactSession, sessionNamespace) {
  const persisted = [];
  for (const output of outputEvidence.outputs) {
    await verifyArtifactSessionRoot(artifactSession);
    const locator = await writeArtifactToCas(output.bytes, {
      artifactRoot: artifactSession.canonicalPath,
      artifactKind: 'cold_build_artifact',
      mediaType: output.metadata.declaredMediaType,
      role: 'cold_build_output',
      producer: { name: 'arbitrary_cold_project_runner', kind: 'cold_build' },
      producerSubsystem: 'gpu_hmr_cold_path',
      sessionNamespace,
      includeLocalPath: true,
    });
    await verifyArtifactSessionRoot(artifactSession);
    const transportEvidence = await validateArtifactCasManifest(locator, {
      artifactRoot: artifactSession.canonicalPath,
      allowedRoots: [artifactSession.canonicalPath],
    });
    await verifyArtifactSessionRoot(artifactSession);
    if (
      transportEvidence.accepted !== true
      || transportEvidence.acceptedAsTransportEvidence !== true
      || transportEvidence.acceptedForGpuHmr !== false
      || transportEvidence.gpuHmrSuccess !== false
      || locator.contentHash !== output.metadata.observedContentHash
      || locator.byteLength !== output.metadata.observedByteLength
    ) {
      throw new Error('arbitrary_cold_runner_artifact_transport_refused');
    }
    persisted.push({
      metadata: { ...output.metadata },
      bytes: Buffer.from(output.bytes),
      artifactLocator: locator,
      transportEvidence,
    });
  }
  return persisted;
}

function artifactLocatorProjection(outputs) {
  return outputs.map((output) => ({
    path: output.metadata.path,
    contentHash: output.metadata.observedContentHash,
    byteLength: output.metadata.observedByteLength,
    artifactId: output.artifactLocator.artifactId,
    manifestHash: output.artifactLocator.manifestHash,
    transportKind: output.artifactLocator.transport.kind,
  })).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
}

export async function runArbitraryColdProject(descriptorInput, {
  artifactRoot,
  dockerExecutable = 'docker',
  policy = {},
} = {}) {
  const started = process.hrtime.bigint();
  const normalizedPolicy = normalizePolicy(policy);
  const descriptor = normalizeArbitraryColdProjectDescriptor(descriptorInput, {
    policy: normalizedPolicy,
  });
  const descriptorHash = contentHash(stableJson(descriptor));
  const artifactRootStarted = process.hrtime.bigint();
  const artifactRootIdentity = await inspectArtifactRoot(artifactRoot, descriptor.sourceRoot);
  const artifactRootValidationNanos = Number(
    process.hrtime.bigint() - artifactRootStarted
  );
  const imageStarted = process.hrtime.bigint();
  const workerImage = await inspectImmutableColdBuildWorkerImage(
    descriptor.workerImage,
    { dockerExecutable },
  );
  verifyImmutableColdBuildWorkerImage(workerImage, descriptor.workerImage);
  const imageInspectionNanos = Number(process.hrtime.bigint() - imageStarted);

  const sourceStarted = process.hrtime.bigint();
  const sourceTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
    descriptor.sourceRoot,
    descriptor.sourceLimits,
  );
  verifyColdBuildSourceTreeBindingEvidence(sourceTreeBindingEvidence, descriptor.sourceRoot);
  const sourceBindingNanos = Number(process.hrtime.bigint() - sourceStarted);

  const contract = createArbitraryColdProjectContract({
    sourceBindingHash: sourceTreeBindingEvidence.sourceBindingHash,
    workerImageId: workerImage.descriptor.imageId,
    workerImageOperatingSystem: workerImage.descriptor.operatingSystem,
    workerImageArchitecture: workerImage.descriptor.architecture,
    containerRuntime: descriptor.containerRuntime,
    command: descriptor.command,
    args: descriptor.args,
    environment: descriptor.environment,
    workingDirectory: descriptor.workingDirectory,
    outputs: descriptor.outputs,
    resources: descriptor.resources,
  });
  verifyArbitraryColdProjectContract(contract);

  let orchestration = null;
  try {
    orchestration = await createPrivateOrchestrationRoot();
    const releaseTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
      orchestration.releaseHostPath,
      { maxEntryCount: 64, maxByteLength: 1024 * 1024 },
    );
    const launcherStarted = process.hrtime.bigint();
    const launcherIdentity = await materializeColdBuildLauncher({
      dockerExecutable,
      architecture: workerImage.descriptor.architecture,
    });
    const launcherMaterializationNanos = Number(process.hrtime.bigint() - launcherStarted);
    const plan = createColdBuildLauncherExecutionPlan({
      launcherIdentity,
      executionNonce: randomBytes(16).toString('hex'),
      commandSpecHash: contract.commandSpecHash,
      sourceTreeBindingEvidence,
      releaseTreeBindingEvidence,
      command: contract.command,
      args: contract.args,
      environment: contract.environment,
      workingDirectory: mapWorkingDirectory(contract.workingDirectory),
      commandTimeoutMillis: contract.resources.commandTimeoutMillis,
      releaseTimeoutMillis: contract.resources.releaseTimeoutMillis,
      workspaceByteLimit: contract.resources.workspaceByteLimit,
      workspaceEntryLimit: contract.resources.workspaceEntryLimit,
      collectedByteLimit: contract.resources.collectedByteLimit,
      collectedEntryLimit: contract.resources.collectedEntryLimit,
      outputManifestMode: contract.outputManifestMode,
      declaredOutputs: contractOutputDeclarations(contract),
      containerName: `synthi-arbitrary-cold-${randomBytes(10).toString('hex')}`,
      workerImageId: workerImage.descriptor.imageId,
      workerImageEnvironment: workerImage.descriptor.environment,
      workerImageOperatingSystem: workerImage.descriptor.operatingSystem,
      workerImageArchitecture: workerImage.descriptor.architecture,
      containerRuntime: contract.containerRuntime,
      sourceHostPath: descriptor.sourceRoot,
      releaseHostPath: orchestration.releaseHostPath,
      specHostDirectory: orchestration.specHostDirectory,
      memoryBytes: contract.resources.memoryBytes,
      memorySwapBytes: contract.resources.memorySwapBytes,
      nanoCpus: contract.resources.nanoCpus,
      pidsLimit: contract.resources.pidsLimit,
      nofileLimit: contract.resources.nofileLimit,
    });
    const executionStarted = process.hrtime.bigint();
    const driverResult = await executeColdBuildLauncherPlan(plan, { dockerExecutable });
    verifyColdBuildExecutionDriverResult(driverResult, plan);
    const executionNanos = Number(process.hrtime.bigint() - executionStarted);
    const outputStarted = process.hrtime.bigint();
    const outputEvidence = deriveColdBuildOutputEvidence(driverResult, plan);
    verifyColdBuildOutputEvidence(outputEvidence, driverResult, plan);
    const expectedOutputContract = outputContractProjection(contract);
    const observedOutputContract = observedOutputContractProjection(outputEvidence);
    if (stableJson(expectedOutputContract) !== stableJson(observedOutputContract)) {
      throw new Error('arbitrary_cold_runner_output_contract_mismatch');
    }
    const outputEvidenceNanos = Number(process.hrtime.bigint() - outputStarted);

    const persistenceStarted = process.hrtime.bigint();
    const artifactSession = await createArtifactSessionRoot(artifactRootIdentity);
    const outputs = await persistOutputs(
      outputEvidence,
      artifactSession,
      `cold-${plan.planHash.slice('sha256:'.length, 'sha256:'.length + 24)}`,
    );
    const artifactPersistenceNanos = Number(process.hrtime.bigint() - persistenceStarted);
    const locatorProjection = artifactLocatorProjection(outputs);
    const evidence = {
      schemaVersion: ARBITRARY_COLD_PROJECT_RUN_SCHEMA,
      proofAuthority: ARBITRARY_COLD_PROJECT_RUN_AUTHORITY,
      descriptorHash,
      sourcePathIdentityHash: pathIdentityHash(descriptor.sourceRoot),
      sourceBindingHash: sourceTreeBindingEvidence.sourceBindingHash,
      sourceTreeBindingEvidenceHash: sourceTreeBindingEvidence.evidenceHash,
      workerImageEvidenceHash: workerImage.evidence.evidenceHash,
      workerImageId: workerImage.descriptor.imageId,
      contractHash: contract.contractHash,
      commandSpecHash: contract.commandSpecHash,
      launcherExecutableHash: launcherIdentity.binaryHash,
      planHash: plan.planHash,
      driverExecutionEvidenceHash: driverResult.evidence.evidenceHash,
      outputEvidenceHash: outputEvidence.evidence.evidenceHash,
      outputSetHash: outputEvidence.evidence.outputSetHash,
      outputContractHash: contentHash(stableJson(expectedOutputContract)),
      artifactSessionRootIdentityHash: pathIdentityHash(artifactSession.canonicalPath),
      artifactLocatorSetHash: contentHash(stableJson(locatorProjection)),
      artifactCount: outputs.length,
      timings: {
        metricClock: 'monotonic_ns',
        metricScope: 'cold',
        artifactRootValidationNanos,
        imageInspectionNanos,
        sourceBindingNanos,
        launcherMaterializationNanos,
        executionNanos,
        outputEvidenceNanos,
        artifactPersistenceNanos,
        totalRunnerWallNanos: Number(process.hrtime.bigint() - started),
      },
      coldBuildSucceeded: true,
      acceptedAsColdBuildEvidence: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
    };
    evidence.evidenceHash = recomputeEvidenceHash(evidence);
    const result = {
      evidence,
      outputs,
      artifactSessionRoot: artifactSession.canonicalPath,
    };
    PINNED_RUNS.set(result, Object.freeze({
      descriptor,
      descriptorHash,
      artifactSession,
      sourceTreeBindingEvidence,
      workerImage,
      contract,
      launcherIdentity,
      plan,
      driverResult,
      outputEvidence,
      evidenceHash: evidence.evidenceHash,
    }));
    return result;
  } finally {
    await removePrivateOrchestrationRoot(orchestration?.root);
  }
}

export async function verifyArbitraryColdProjectRun(result) {
  const pinned = PINNED_RUNS.get(result);
  if (!pinned) {
    throw new Error('arbitrary_cold_runner_result_invalid');
  }
  try {
    await verifyArtifactSessionRoot(pinned.artifactSession);
    verifyColdBuildSourceTreeBindingEvidence(
      pinned.sourceTreeBindingEvidence,
      pinned.descriptor.sourceRoot,
    );
    verifyImmutableColdBuildWorkerImage(pinned.workerImage, pinned.descriptor.workerImage);
    verifyArbitraryColdProjectContract(pinned.contract);
    verifyColdBuildExecutionDriverResult(pinned.driverResult, pinned.plan);
    verifyColdBuildOutputEvidence(
      pinned.outputEvidence,
      pinned.driverResult,
      pinned.plan,
    );
  } catch {
    throw new Error('arbitrary_cold_runner_result_invalid');
  }
  const expectedOutputContract = outputContractProjection(pinned.contract);
  const observedOutputContract = observedOutputContractProjection(pinned.outputEvidence);
  const outputs = result?.outputs;
  if (!Array.isArray(outputs) || outputs.length !== pinned.outputEvidence.outputs.length) {
    throw new Error('arbitrary_cold_runner_result_invalid');
  }
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    const expected = pinned.outputEvidence.outputs[index];
    if (
      stableJson(output?.metadata) !== stableJson(expected.metadata)
      || !Buffer.isBuffer(output?.bytes)
      || !output.bytes.equals(expected.bytes)
      || output?.artifactLocator?.contentHash !== expected.metadata.observedContentHash
      || output?.artifactLocator?.byteLength !== expected.metadata.observedByteLength
    ) {
      throw new Error('arbitrary_cold_runner_result_invalid');
    }
    const transportEvidence = await validateArtifactCasManifest(output.artifactLocator, {
      artifactRoot: pinned.artifactSession.canonicalPath,
      allowedRoots: [pinned.artifactSession.canonicalPath],
    });
    await verifyArtifactSessionRoot(pinned.artifactSession);
    if (
      transportEvidence.accepted !== true
      || transportEvidence.acceptedAsTransportEvidence !== true
      || stableJson(transportEvidence) !== stableJson(output.transportEvidence)
    ) {
      throw new Error('arbitrary_cold_runner_result_invalid');
    }
  }
  const locatorProjection = artifactLocatorProjection(outputs);
  const evidence = result?.evidence;
  if (
    pinned.evidenceHash !== evidence?.evidenceHash
    || pinned.descriptorHash !== contentHash(stableJson(pinned.descriptor))
    || result?.artifactSessionRoot !== pinned.artifactSession.canonicalPath
    || evidence?.schemaVersion !== ARBITRARY_COLD_PROJECT_RUN_SCHEMA
    || evidence?.proofAuthority !== ARBITRARY_COLD_PROJECT_RUN_AUTHORITY
    || evidence?.descriptorHash !== pinned.descriptorHash
    || evidence?.sourcePathIdentityHash !== pathIdentityHash(pinned.descriptor.sourceRoot)
    || evidence?.sourceBindingHash !== pinned.sourceTreeBindingEvidence.sourceBindingHash
    || evidence?.sourceTreeBindingEvidenceHash !== pinned.sourceTreeBindingEvidence.evidenceHash
    || evidence?.workerImageEvidenceHash !== pinned.workerImage.evidence.evidenceHash
    || evidence?.workerImageId !== pinned.workerImage.descriptor.imageId
    || evidence?.contractHash !== pinned.contract.contractHash
    || evidence?.commandSpecHash !== pinned.contract.commandSpecHash
    || evidence?.launcherExecutableHash !== pinned.launcherIdentity.binaryHash
    || evidence?.planHash !== pinned.plan.planHash
    || evidence?.driverExecutionEvidenceHash !== pinned.driverResult.evidence.evidenceHash
    || evidence?.outputEvidenceHash !== pinned.outputEvidence.evidence.evidenceHash
    || evidence?.outputSetHash !== pinned.outputEvidence.evidence.outputSetHash
    || evidence?.outputContractHash !== contentHash(stableJson(expectedOutputContract))
    || stableJson(expectedOutputContract) !== stableJson(observedOutputContract)
    || evidence?.artifactSessionRootIdentityHash
      !== pathIdentityHash(pinned.artifactSession.canonicalPath)
    || evidence?.artifactLocatorSetHash !== contentHash(stableJson(locatorProjection))
    || evidence?.artifactCount !== outputs.length
    || evidence?.timings?.metricClock !== 'monotonic_ns'
    || evidence?.timings?.metricScope !== 'cold'
    || Object.entries(evidence?.timings ?? {}).some(([name, value]) => (
      name.endsWith('Nanos') && (!Number.isSafeInteger(value) || value < 0)
    ))
    || evidence?.coldBuildSucceeded !== true
    || evidence?.acceptedAsColdBuildEvidence !== true
    || evidence?.acceptedForGpuHmr !== false
    || evidence?.gpuHmrSuccess !== false
    || evidence?.canSatisfyRuntimeProof !== false
    || evidence?.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(evidence) !== evidence?.evidenceHash
  ) {
    throw new Error('arbitrary_cold_runner_result_invalid');
  }
  return result;
}

function parseCliArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !['--descriptor', '--artifact-root', '--docker'].includes(name)
      || typeof value !== 'string'
      || value.length < 1
      || Object.hasOwn(values, name)
    ) {
      throw new Error('arbitrary_cold_runner_cli_arguments_invalid');
    }
    values[name] = value;
  }
  if (!values['--descriptor'] || !values['--artifact-root']) {
    throw new Error('arbitrary_cold_runner_cli_arguments_invalid');
  }
  return values;
}

async function main() {
  const args = parseCliArguments(process.argv.slice(2));
  const descriptorBytes = await readFile(
    requireHostPath(args['--descriptor'], 'descriptor_path'),
  );
  if (descriptorBytes.byteLength < 2 || descriptorBytes.byteLength > 1024 * 1024) {
    throw new Error('arbitrary_cold_runner_descriptor_bytes_invalid');
  }
  let descriptor;
  try {
    descriptor = JSON.parse(descriptorBytes.toString('utf8'));
  } catch {
    throw new Error('arbitrary_cold_runner_descriptor_json_invalid');
  }
  const result = await runArbitraryColdProject(descriptor, {
    artifactRoot: args['--artifact-root'],
    dockerExecutable: args['--docker'] ?? 'docker',
  });
  await verifyArbitraryColdProjectRun(result);
  console.log(JSON.stringify({
    descriptorBytesHash: contentHash(descriptorBytes),
    evidence: result.evidence,
    outputs: result.outputs.map((output) => ({
      metadata: output.metadata,
      artifactLocator: output.artifactLocator,
      transportEvidence: output.transportEvidence,
    })),
  }, null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
