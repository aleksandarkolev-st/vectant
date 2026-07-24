import { types as utilTypes } from 'node:util';

import {
  snapshotPortableArtifactCasManifestInput,
  validateArtifactCasManifest,
} from './gpu-hmr-artifact-cas.mjs';
import {
  COLD_EXECUTION_AUTHORITY_LIMITS,
  createControlledExecutionGraph,
  readVerifiedRegularFile,
  removeControlledExecutionGraph,
  verifyControlledExecutionGraph,
} from './gpu-hmr-cold-execution-authority.mjs';

const GRAPH_INPUT_ROLES = Object.freeze({
  entry: 'generated_ecmascript_entry',
  module: 'ecmascript_module_root',
  support: 'support_input',
});
const contentAddressedGraphPackageBrand = new WeakMap();

function exactRecord(value, keys, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label}_invalid`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length
    || ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError(`${label}_fields_invalid`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${label}_field_invalid`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedArray(value, label) {
  if (
    !Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > COLD_EXECUTION_AUTHORITY_LIMITS.graphRoots
  ) {
    throw new TypeError(`${label}_invalid`);
  }
  const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError(`${label}_invalid`);
  }
  const ownNames = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length !== 0
    || ownNames.length !== length + 1
    || !ownNames.includes('length')
  ) {
    throw new TypeError(`${label}_invalid`);
  }
  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${label}_invalid`);
    }
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

function snapshotArtifactInput(value, graphInputRole, label) {
  const record = exactRecord(value, ['relativePath', 'locator'], label);
  if (
    typeof record.relativePath !== 'string'
    || record.relativePath.length === 0
  ) {
    throw new TypeError(`${label}_relative_path_invalid`);
  }
  const locator = snapshotPortableArtifactCasManifestInput(record.locator);
  if (locator === null) {
    throw new TypeError(`${label}_locator_invalid`);
  }
  return Object.freeze({
    graphInputRole,
    relativePath: record.relativePath,
    locator,
  });
}

function snapshotInput(value) {
  const input = exactRecord(
    value,
    ['trustedRoot', 'allowedRoots', 'entry', 'modules', 'supports'],
    'content_addressed_controlled_graph_input',
  );
  if (typeof input.trustedRoot !== 'string' || input.trustedRoot.length === 0) {
    throw new TypeError(
      'content_addressed_controlled_graph_trusted_root_invalid',
    );
  }
  const allowedRoots = boundedArray(
    input.allowedRoots,
    'content_addressed_controlled_graph_allowed_roots',
  );
  if (
    allowedRoots.length === 0
    || allowedRoots.some((root) => typeof root !== 'string' || root.length === 0)
  ) {
    throw new TypeError(
      'content_addressed_controlled_graph_allowed_roots_invalid',
    );
  }
  const modules = boundedArray(
    input.modules,
    'content_addressed_controlled_graph_modules',
  ).map((entry, index) => snapshotArtifactInput(
    entry,
    'module',
    `content_addressed_controlled_graph_module_${index}`,
  ));
  const supports = boundedArray(
    input.supports,
    'content_addressed_controlled_graph_supports',
  ).map((entry, index) => snapshotArtifactInput(
    entry,
    'support',
    `content_addressed_controlled_graph_support_${index}`,
  ));
  const artifacts = [
    snapshotArtifactInput(
      input.entry,
      'entry',
      'content_addressed_controlled_graph_entry',
    ),
    ...modules,
    ...supports,
  ];
  if (artifacts.length > COLD_EXECUTION_AUTHORITY_LIMITS.graphRoots) {
    throw new TypeError(
      'content_addressed_controlled_graph_artifact_count_unbounded',
    );
  }
  return Object.freeze({
    trustedRoot: input.trustedRoot,
    allowedRoots: Object.freeze([...allowedRoots]),
    artifacts: Object.freeze(artifacts),
  });
}

async function readValidatedArtifactBytes(
  artifact,
  allowedRoots,
  validation,
  remainingBytes,
) {
  if (
    validation.accepted !== true
    || validation.acceptedAsTransportEvidence !== true
    || validation.contentHash === null
    || validation.manifestHash === null
    || !Number.isSafeInteger(validation.byteLength)
    || validation.byteLength < 0
    || typeof validation.supportPath !== 'string'
    || validation.supportPath.length === 0
  ) {
    const refusalReasons = [
      ...(Array.isArray(validation?.reasons) ? validation.reasons : []),
      ...(Array.isArray(validation?.gaps) ? validation.gaps : []),
    ];
    throw new Error(
      [
        'content_addressed_controlled_graph_artifact_invalid',
        artifact.relativePath,
        refusalReasons.length > 0
          ? [...new Set(refusalReasons)].join(',')
          : 'verified_byte_binding_mismatch',
      ].join(':'),
    );
  }
  if (
    !Number.isSafeInteger(remainingBytes)
    || remainingBytes < 0
    || validation.byteLength > remainingBytes
  ) {
    throw new Error(
      'content_addressed_controlled_graph_actual_bytes_unbounded',
    );
  }
  const readLimit = Math.max(1, validation.byteLength);
  for (const trustedRoot of allowedRoots) {
    try {
      const observation = await readVerifiedRegularFile(
        validation.supportPath,
        {
          trustedRoot,
          allowEmpty: true,
          label: 'content_addressed_controlled_graph_artifact',
          maxBytes: readLimit,
        },
      );
      if (
        observation.hash === validation.contentHash
        && observation.byteLength === validation.byteLength
      ) {
        return Object.freeze({
          bytes: Buffer.from(observation.bytes),
          binding: Object.freeze({
            graphInputRole: artifact.graphInputRole,
            relativePath: artifact.relativePath,
            manifestHash: validation.manifestHash,
            contentHash: observation.hash,
            byteLength: observation.byteLength,
            verifiedFileIdentity: observation.identity,
          }),
        });
      }
    } catch {
      // Try the next declared root. Every accepted byte snapshot is rehashed.
    }
  }
  throw new Error(
    `content_addressed_controlled_graph_artifact_unreadable:${artifact.relativePath}`,
  );
}

function graphMatchesDeclaredArtifacts(graph, artifacts) {
  if (!Array.isArray(graph?.entries) || graph.entries.length !== artifacts.length) {
    return false;
  }
  const expected = new Map(artifacts.map((artifact) => [
    artifact.binding.relativePath,
    artifact,
  ]));
  if (expected.size !== artifacts.length) return false;
  for (const entry of graph.entries) {
    const artifact = expected.get(entry.relativePath);
    if (
      !artifact
      || entry.role !== GRAPH_INPUT_ROLES[artifact.binding.graphInputRole]
      || entry.contentHash !== artifact.binding.contentHash
      || entry.byteLength !== artifact.binding.byteLength
    ) {
      return false;
    }
  }
  return true;
}

function contentAddressedGraphPackageState(value) {
  if (
    value === null
    || typeof value !== 'object'
    || utilTypes.isProxy(value)
  ) {
    return null;
  }
  const state = contentAddressedGraphPackageBrand.get(value);
  if (
    !state
    || value.graph !== state.graph
    || value.graphHash !== state.graph.graphHash
    || value.artifactBindings !== state.artifactBindings
  ) {
    return null;
  }
  return state;
}

export async function createContentAddressedControlledExecutionGraph(value) {
  const input = snapshotInput(value);
  const validations = [];
  for (const artifact of input.artifacts) {
    validations.push(await validateArtifactCasManifest(artifact.locator, {
      allowedRoots: input.allowedRoots,
      requireReadableBytes: false,
    }));
  }
  const totalDeclaredBytes = validations.reduce((total, validation) => (
    Number.isSafeInteger(validation?.byteLength)
      ? total + validation.byteLength
      : Number.POSITIVE_INFINITY
  ), 0);
  if (
    !Number.isSafeInteger(totalDeclaredBytes)
    || totalDeclaredBytes > COLD_EXECUTION_AUTHORITY_LIMITS.graphBytes
  ) {
    throw new Error(
      'content_addressed_controlled_graph_declared_bytes_unbounded',
    );
  }
  const artifacts = [];
  let remainingBytes = COLD_EXECUTION_AUTHORITY_LIMITS.graphBytes;
  for (let index = 0; index < input.artifacts.length; index += 1) {
    const artifact = await readValidatedArtifactBytes(
      input.artifacts[index],
      input.allowedRoots,
      validations[index],
      remainingBytes,
    );
    artifacts.push(artifact);
    remainingBytes -= artifact.binding.byteLength;
  }
  let graph = null;
  try {
    const entry = artifacts.find(
      (artifact) => artifact.binding.graphInputRole === 'entry',
    );
    const modules = artifacts.filter(
      (artifact) => artifact.binding.graphInputRole === 'module',
    );
    const supports = artifacts.filter(
      (artifact) => artifact.binding.graphInputRole === 'support',
    );
    graph = await createControlledExecutionGraph({
      trustedRoot: input.trustedRoot,
      entryRelativePath: entry.binding.relativePath,
      entryBytes: entry.bytes,
      moduleEntryPaths: [],
      moduleEntries: modules.map((artifact) => ({
        relativePath: artifact.binding.relativePath,
        bytes: artifact.bytes,
      })),
      supportFilePaths: [],
      supportEntries: supports.map((artifact) => ({
        relativePath: artifact.binding.relativePath,
        bytes: artifact.bytes,
      })),
    });
    if (!graphMatchesDeclaredArtifacts(graph, artifacts)) {
      throw new Error(
        'content_addressed_controlled_graph_undeclared_dependency',
      );
    }
    if (await verifyControlledExecutionGraph(graph) !== true) {
      throw new Error(
        'content_addressed_controlled_graph_materialized_graph_invalid',
      );
    }
    const artifactBindings = Object.freeze(
      artifacts.map((artifact) => artifact.binding),
    );
    const graphPackage = Object.freeze({
      graph,
      graphHash: graph.graphHash,
      artifactBindings,
      supportEvidenceOnly: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    contentAddressedGraphPackageBrand.set(graphPackage, Object.freeze({
      graph,
      artifactBindings,
    }));
    return graphPackage;
  } catch (error) {
    if (graph !== null) {
      await removeControlledExecutionGraph(graph);
    }
    throw error;
  } finally {
    for (const artifact of artifacts) artifact.bytes.fill(0);
  }
}

export async function verifyContentAddressedControlledExecutionGraphPackage(
  value,
) {
  const state = contentAddressedGraphPackageState(value);
  return state !== null
    && await verifyControlledExecutionGraph(state.graph) === true;
}
