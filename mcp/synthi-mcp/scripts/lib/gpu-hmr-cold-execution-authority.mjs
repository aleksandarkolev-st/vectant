import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { types as utilTypes } from 'node:util';
import * as acorn from 'acorn';

export const COLD_EXECUTION_AUTHORITY_SCHEMAS = Object.freeze({
  verifiedFile: 'synthi.gpu_hmr.cold_execution_verified_file.v1',
  controlledGraph: 'synthi.gpu_hmr.cold_execution_controlled_ecmascript_graph.v1',
  executableBinding: 'synthi.gpu_hmr.cold_execution_prelaunch_executable_binding.v1',
  processObservation: 'synthi.gpu_hmr.cold_execution_process_observation.v1',
  stdinEntryInvocationClassification:
    'synthi.gpu_hmr.cold_execution_stdin_entry_invocation_classification.v1',
  runtimeEntryConsumptionReceipt:
    'synthi.gpu_hmr.cold_execution_runtime_entry_consumption_receipt.v1',
  exclusiveStdinInterpretedEntrySet:
    'synthi.gpu_hmr.cold_execution_exclusive_stdin_interpreted_entry_set.v1',
  verifiedResultReceipt: 'synthi.gpu_hmr.cold_execution_verified_result_receipt.v1',
  observedAuthority: 'synthi.gpu_hmr.cold_execution_observed_authority.v1',
});

export const COLD_EXECUTION_AUTHORITY_LIMITS = Object.freeze({
  graphFiles: 20_000,
  graphBytes: 512 * 1024 * 1024,
  graphRoots: 4_096,
  graphOutputs: 128,
  pathBytes: 16 * 1024,
  processArguments: 4_096,
  processArgumentBytes: 16 * 1024 * 1024,
  environmentEntries: 4_096,
  environmentBytes: 16 * 1024 * 1024,
  capturedStreamBytes: 16 * 1024 * 1024,
  verifiedFileBytes: 512 * 1024 * 1024,
  recordKeys: 64,
});

const AUTHORITY_KINDS = Object.freeze(new Set([
  'stdin_entry_bytes',
  'controlled_ecmascript_graph',
]));
const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const CANONICAL_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const controlledGraphBrand = new WeakMap();
const processObservationBrand = new WeakMap();
const processExecutionContextBrand = new WeakMap();
// No JavaScript issuer exists; only a future trusted native observer integration may brand one.
const trustedRuntimeEntryObserverBrand = new WeakSet();
const runtimeEntryConsumptionReceiptBrand = new WeakMap();
const verifiedResultReceiptBrand = new WeakMap();
const CANONICAL_EXCLUSIVE_STDIN_INTERPRETER_MODE =
  'runtime_observed_exclusive_stdin_entry_bytes';
const ENTRY_CONSUMPTION_ATTESTATION_GAP = 'entry_consumption_attestation_missing';
const SIDE_LOAD_ENVIRONMENT_NAMES = new Set([
  'BASH_ENV',
  'CLASSPATH',
  'CORECLR_ENABLE_PROFILING',
  'CORECLR_PROFILER',
  'CORECLR_PROFILER_PATH',
  'COR_ENABLE_PROFILING',
  'COR_PROFILER',
  'COR_PROFILER_PATH',
  'DOTNET_ADDITIONAL_DEPS',
  'DOTNET_STARTUP_HOOKS',
  'ENV',
  'GCONV_PATH',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LDR_CNTRL',
  'LDR_PRELOAD',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'LIBPATH',
  'LOCPATH',
  'LUA_CPATH',
  'LUA_INIT',
  'LUA_PATH',
  'NLSPATH',
  'NODE_COMPILE_CACHE',
  'NODE_EXTRA_CA_CERTS',
  'NODE_ICU_DATA',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_SEA_BLOB',
  'OPENSSL_CONF',
  'OPENSSL_CONF_INCLUDE',
  'OPENSSL_ENGINES',
  'OPENSSL_FORCE_FIPS_MODE',
  'OPENSSL_MODULES',
  'PATH',
  'PATHEXT',
  'PERL5LIB',
  'PERL5OPT',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYLIB',
  'RUBYOPT',
  'SHLIB_PATH',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  '_JAVA_OPTIONS',
]);
const STATIC_GRAPH_PROHIBITED_SPECIFIERS = new Set([
  'child_process',
  'cluster',
  'inspector',
  'module',
  'node:child_process',
  'node:cluster',
  'node:inspector',
  'node:module',
  'node:process',
  'node:repl',
  'node:sqlite',
  'node:vm',
  'node:wasi',
  'node:worker_threads',
  'process',
  'repl',
  'sqlite',
  'vm',
  'wasi',
  'worker_threads',
]);
const STATIC_GRAPH_PROHIBITED_IDENTIFIERS = new Set([
  'AsyncFunction',
  'Function',
  'GeneratorFunction',
  'SharedWorker',
  'Worker',
  'Proxy',
  'Reflect',
  'WebAssembly',
  'createRequire',
  'eval',
  'module',
  'require',
]);
const STATIC_GRAPH_PROHIBITED_REFLECTION_NAMES = new Set([
  '__lookupGetter__',
  '__proto__',
  'constructor',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'getOwnPropertyNames',
  'getOwnPropertySymbols',
  'getPrototypeOf',
  'setPrototypeOf',
]);
const STATIC_GRAPH_PROHIBITED_PROCESS_MEMBERS = new Set([
  '_linkedBinding',
  'binding',
  'dlopen',
  'getBuiltinModule',
  'mainModule',
]);
const REGISTERED_GRAPH_RESULT_ROLE = 'registered_graph_process_result';

function byteHash(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite number is not canonical');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen));
  if (typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new TypeError('value is not canonical plain data');
  }
  if (seen.has(value)) throw new TypeError('cyclic value is not canonical');
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError('value is not a canonical plain record');
  }
  seen.add(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > COLD_EXECUTION_AUTHORITY_LIMITS.recordKeys) {
    throw new TypeError('canonical record has too many fields');
  }
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('canonical record contains a symbol field');
  }
  const descriptors = new Map();
  for (const key of ownKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new TypeError('record contains a non-data property');
    }
    descriptors.set(key, descriptor);
  }
  const output = {};
  for (const key of [...ownKeys].sort()) {
    const descriptor = descriptors.get(key);
    if (descriptor.value === undefined) throw new TypeError('undefined is not canonical');
    output[key] = canonicalValue(descriptor.value, seen);
  }
  seen.delete(value);
  return output;
}

function stableJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function valueHash(value) {
  return byteHash(Buffer.from(stableJson(value), 'utf8'));
}

function isPlainRecord(value) {
  try {
    inspectBoundedDataRecord(value, 'plain_record');
    return true;
  } catch {
    return false;
  }
}

function inspectBoundedDataRecord(
  value,
  label,
  maximumKeys = COLD_EXECUTION_AUTHORITY_LIMITS.recordKeys,
) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new TypeError(`${label}_not_plain_record`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > maximumKeys) throw new TypeError(`${label}_fields_unbounded`);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError(`${label}_symbol_field_refused`);
  }
  const descriptors = new Map();
  for (const key of ownKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true
    ) throw new TypeError(`${label}_non_data_field_refused`);
    descriptors.set(key, descriptor);
  }
  return Object.freeze({
    keys: Object.freeze([...ownKeys].sort()),
    descriptors,
  });
}

function exactRecordValues(inspection, keys, label) {
  const expected = [...keys].sort();
  if (
    inspection.keys.length !== expected.length
    || inspection.keys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label}_fields_invalid`);
  }
  return Object.freeze(Object.fromEntries(
    expected.map((key) => [key, inspection.descriptors.get(key).value]),
  ));
}

function assertExactRecord(value, keys, label) {
  return exactRecordValues(
    inspectBoundedDataRecord(value, label, keys.length),
    keys,
    label,
  );
}

function assertBoundedArray(value, maximum, label) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length > maximum) {
    throw new TypeError(`${label}_invalid_or_unbounded`);
  }
}

function assertBoundedPathText(value, label) {
  if (
    typeof value !== 'string'
    || value.trim() === ''
    || Buffer.byteLength(value, 'utf8') > COLD_EXECUTION_AUTHORITY_LIMITS.pathBytes
  ) throw new TypeError(`${label}_invalid_or_unbounded`);
}

function normalizeRelativePath(value, label) {
  assertBoundedPathText(value, label);
  if (
    value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value)
  ) throw new TypeError(`${label}_must_be_canonical_relative_path`);
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError(`${label}_must_be_canonical_relative_path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) throw new TypeError(`${label}_must_be_canonical_relative_path`);
  return normalized;
}

function sameFilesystemPath(left, right) {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function filesystemPathKey(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInsideDirectory(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function relativePathInside(root, candidate, label = 'path') {
  const resolved = path.resolve(candidate);
  if (!isInsideDirectory(root, resolved)) throw new Error(`${label}_escaped_trusted_root`);
  const relative = path.relative(root, resolved).replace(/\\/g, '/');
  return normalizeRelativePath(relative, `${label}_relative`);
}

function fileIdentity(metadata) {
  return Object.freeze({
    device: String(metadata.dev),
    inode: String(metadata.ino),
    size: String(metadata.size),
    mode: String(metadata.mode),
    mtimeMs: String(metadata.mtimeMs),
    ctimeMs: String(metadata.ctimeMs),
    birthtimeMs: String(metadata.birthtimeMs),
  });
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && Object.keys(left).every((key) => {
    if (
      key === 'device'
      && process.platform === 'win32'
      && (left[key] === '0' || right[key] === '0')
    ) return true;
    return left[key] === right[key];
  }));
}

function executableFileIdentity(metadata) {
  const deviceIdentity = typeof metadata?.dev === 'bigint'
    ? metadata.dev.toString()
    : null;
  const inodeIdentity = typeof metadata?.ino === 'bigint'
    ? metadata.ino.toString()
    : null;
  const identityAvailable = Boolean(
    deviceIdentity
    && inodeIdentity
    && deviceIdentity !== '0'
    && inodeIdentity !== '0'
  );
  return Object.freeze({
    identityKind: 'node_bigint_filesystem_identity',
    identityAvailable,
    volumeIdentity: deviceIdentity,
    deviceIdentity,
    inodeIdentity,
    fileIndexIdentity: inodeIdentity,
  });
}

function sameExecutableFileIdentity(left, right) {
  return Boolean(
    left?.identityAvailable === true
    && right?.identityAvailable === true
    && left.volumeIdentity === right.volumeIdentity
    && left.deviceIdentity === right.deviceIdentity
    && left.inodeIdentity === right.inodeIdentity
    && left.fileIndexIdentity === right.fileIndexIdentity
  );
}

function sameRecordedExecutableFileIdentity(left, right) {
  return Boolean(
    left
    && right
    && left.volumeIdentity === right.volumeIdentity
    && left.deviceIdentity === right.deviceIdentity
    && left.inodeIdentity === right.inodeIdentity
    && left.fileIndexIdentity === right.fileIndexIdentity
  );
}

async function verifiedTrustedRoot(trustedRoot, label) {
  assertBoundedPathText(trustedRoot, `${label}_trusted_root`);
  const requestedRoot = path.resolve(trustedRoot);
  const metadata = await lstat(requestedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label}_trusted_root_not_directory`);
  }
  const resolvedRoot = await realpath(requestedRoot);
  if (!sameFilesystemPath(requestedRoot, resolvedRoot)) {
    throw new Error(`${label}_trusted_root_linked`);
  }
  return resolvedRoot;
}

export async function readVerifiedRegularFile(
  filePath,
  {
    trustedRoot,
    allowEmpty = true,
    label = 'verified_file',
    maxBytes = COLD_EXECUTION_AUTHORITY_LIMITS.verifiedFileBytes,
  } = {},
) {
  assertBoundedPathText(String(filePath ?? ''), `${label}_path`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
    || maxBytes > COLD_EXECUTION_AUTHORITY_LIMITS.verifiedFileBytes) {
    throw new TypeError(`${label}_max_bytes_invalid`);
  }
  const root = await verifiedTrustedRoot(trustedRoot, label);
  const requested = path.resolve(filePath);
  if (!isInsideDirectory(root, requested)) throw new Error(`${label}_escaped_trusted_root`);
  const requestedMetadata = await lstat(requested);
  if (
    !requestedMetadata.isFile()
    || requestedMetadata.isSymbolicLink()
    || requestedMetadata.size > maxBytes
  ) throw new Error(`${label}_not_regular_or_bounded`);
  const resolved = await realpath(requested);
  if (!isInsideDirectory(root, resolved) || !sameFilesystemPath(requested, resolved)) {
    throw new Error(`${label}_symlink_or_junction_resolution_refused`);
  }
  let ancestor = path.dirname(requested);
  while (isInsideDirectory(root, ancestor) && !sameFilesystemPath(ancestor, root)) {
    const ancestorMetadata = await lstat(ancestor);
    if (!ancestorMetadata.isDirectory() || ancestorMetadata.isSymbolicLink()) {
      throw new Error(`${label}_linked_ancestor_refused`);
    }
    const resolvedAncestor = await realpath(ancestor);
    if (!sameFilesystemPath(ancestor, resolvedAncestor)) {
      throw new Error(`${label}_junction_ancestor_refused`);
    }
    ancestor = path.dirname(ancestor);
  }
  const openFlags = process.platform === 'win32'
    ? fsConstants.O_RDONLY
    : fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(requested, openFlags);
  try {
    const beforeHandle = await handle.stat();
    const beforePath = await lstat(requested);
    const beforeIdentity = fileIdentity(beforeHandle);
    if (
      !beforeHandle.isFile()
      || beforeHandle.size > maxBytes
      || beforePath.isSymbolicLink()
      || !sameFileIdentity(beforeIdentity, fileIdentity(beforePath))
    ) throw new Error(`${label}_handle_path_identity_mismatch`);
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) throw new Error(`${label}_size_limit_exceeded`);
    if (!allowEmpty && bytes.byteLength === 0) throw new Error(`${label}_empty`);
    const afterHandle = await handle.stat();
    const afterPath = await lstat(requested);
    const postResolved = await realpath(requested);
    const afterIdentity = fileIdentity(afterHandle);
    if (
      !sameFileIdentity(beforeIdentity, afterIdentity)
      || afterPath.isSymbolicLink()
      || !sameFileIdentity(afterIdentity, fileIdentity(afterPath))
      || !sameFilesystemPath(requested, postResolved)
    ) throw new Error(`${label}_changed_during_read`);
    return Object.freeze({
      schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.verifiedFile,
      path: requested,
      trustedRoot: root,
      bytes,
      hash: byteHash(bytes),
      byteLength: bytes.byteLength,
      identity: afterIdentity,
    });
  } finally {
    await handle.close();
  }
}

export async function verifyPreviouslyReadRegularFile(observation) {
  if (
    observation?.schemaVersion !== COLD_EXECUTION_AUTHORITY_SCHEMAS.verifiedFile
    || !observation.path
    || !observation.trustedRoot
    || !observation.identity
  ) return false;
  try {
    const current = await readVerifiedRegularFile(observation.path, {
      trustedRoot: observation.trustedRoot,
      allowEmpty: observation.byteLength === 0,
      label: 'post_execution_verified_file',
      maxBytes: Math.max(1, observation.byteLength),
    });
    return current.hash === observation.hash
      && current.byteLength === observation.byteLength
      && sameFileIdentity(current.identity, observation.identity);
  } catch {
    return false;
  }
}

function parseJavaScriptDependencies(sourceText, sourcePath) {
  const sourceType = path.extname(sourcePath).toLowerCase() === '.cjs' ? 'script' : 'module';
  if (sourceType === 'script') {
    throw new Error(`controlled_graph_alternate_loader_refused:${sourcePath}:commonjs_module`);
  }
  const ast = acorn.parse(sourceText, {
    ecmaVersion: 'latest',
    sourceType,
    allowHashBang: true,
  });
  const dependencies = [];
  const unsupportedDynamicLoads = [];
  const prohibitedEscapePaths = [];
  const addLiteral = (node, kind) => {
    if (typeof node?.value === 'string') dependencies.push({ specifier: node.value, kind });
    else unsupportedDynamicLoads.push(kind);
  };
  const memberPropertyName = (node) => {
    if (node?.type !== 'MemberExpression') return null;
    if (!node.computed && node.property?.type === 'Identifier') return node.property.name;
    if (node.computed && node.property?.type === 'Literal'
      && ['string', 'number'].includes(typeof node.property.value)) {
      return String(node.property.value);
    }
    return null;
  };
  const isProcessReference = (node) => {
    if (node?.type === 'Identifier' && node.name === 'process') return true;
    return node?.type === 'MemberExpression'
      && ['global', 'globalThis'].includes(node.object?.name)
      && memberPropertyName(node) === 'process';
  };
  const isGlobalReference = (node) => node?.type === 'Identifier'
    && ['global', 'globalThis'].includes(node.name);
  const walk = (node, parent = null) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration') addLiteral(node.source, node.type);
    if (node.type === 'ExportNamedDeclaration' && node.source) addLiteral(node.source, node.type);
    if (node.type === 'ExportAllDeclaration') addLiteral(node.source, node.type);
    if (node.type === 'ImportExpression') addLiteral(node.source, node.type);
    if (
      node.type === 'Identifier'
      && (
        STATIC_GRAPH_PROHIBITED_IDENTIFIERS.has(node.name)
        || STATIC_GRAPH_PROHIBITED_REFLECTION_NAMES.has(node.name)
      )
    ) prohibitedEscapePaths.push(`identifier:${node.name}`);
    if (
      node.type === 'Identifier'
      && node.name === 'process'
      && !(parent?.type === 'MemberExpression' && parent.object === node)
    ) prohibitedEscapePaths.push('process_escape:aliased_process');
    if (
      node.type === 'Identifier'
      && ['global', 'globalThis'].includes(node.name)
      && !(parent?.type === 'MemberExpression' && parent.object === node)
    ) prohibitedEscapePaths.push('alternate_loader_member:aliased_global');
    if (
      node.type === 'CallExpression'
      && node.callee?.type === 'Identifier'
      && node.callee.name === 'require'
    ) {
      prohibitedEscapePaths.push('loader:require');
    }
    if (
      node.type === 'MemberExpression'
      && memberPropertyName(node) === 'constructor'
    ) {
      prohibitedEscapePaths.push('string_code_generation:constructor');
    }
    if (
      node.type === 'MemberExpression'
      && (
        STATIC_GRAPH_PROHIBITED_IDENTIFIERS.has(memberPropertyName(node))
        || STATIC_GRAPH_PROHIBITED_REFLECTION_NAMES.has(memberPropertyName(node))
      )
    ) {
      prohibitedEscapePaths.push(
        `alternate_loader_member:${memberPropertyName(node)}`,
      );
    }
    if (
      node.type === 'MemberExpression'
      && node.computed === true
      && memberPropertyName(node) === null
    ) {
      prohibitedEscapePaths.push('alternate_loader_member:unresolved_computed_property');
    }
    if (
      node.type === 'MemberExpression'
      && isProcessReference(node.object)
      && STATIC_GRAPH_PROHIBITED_PROCESS_MEMBERS.has(memberPropertyName(node))
    ) {
      prohibitedEscapePaths.push(`process_escape:${memberPropertyName(node)}`);
    }
    if (
      node.type === 'MemberExpression'
      && node.object?.type === 'MetaProperty'
      && node.object.meta?.name === 'import'
      && node.object.property?.name === 'meta'
      && memberPropertyName(node) === 'resolve'
    ) {
      prohibitedEscapePaths.push('loader:import_meta_resolve');
    }
    if (
      node.type === 'MemberExpression'
      && isGlobalReference(node.object)
      && memberPropertyName(node) === 'process'
      && !(parent?.type === 'MemberExpression' && parent.object === node)
    ) prohibitedEscapePaths.push('process_escape:aliased_process');
    for (const [key, value] of Object.entries(node)) {
      if (key === 'start' || key === 'end' || key === 'loc') continue;
      if (Array.isArray(value)) value.forEach((child) => walk(child, node));
      else if (value && typeof value === 'object' && typeof value.type === 'string') {
        walk(value, node);
      }
    }
  };
  walk(ast);
  for (const dependency of dependencies) {
    if (STATIC_GRAPH_PROHIBITED_SPECIFIERS.has(dependency.specifier)) {
      prohibitedEscapePaths.push(`specifier:${dependency.specifier}`);
    }
  }
  return {
    dependencies: dependencies.filter((entry) => typeof entry.specifier === 'string'),
    unsupportedDynamicLoads: [...new Set(unsupportedDynamicLoads)].sort(),
    prohibitedEscapePaths: [...new Set(prohibitedEscapePaths)].sort(),
  };
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

async function packageRootForResolvedModule(trustedRoot, resolvedModulePath, expectedName) {
  let current = path.dirname(resolvedModulePath);
  while (isInsideDirectory(trustedRoot, current)) {
    const manifestPath = path.join(current, 'package.json');
    try {
      const observation = await readVerifiedRegularFile(manifestPath, {
        trustedRoot,
        allowEmpty: false,
        label: 'controlled_graph_package_manifest',
      });
      const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
        observation.bytes,
      ));
      if (manifest?.name === expectedName) {
        return { root: current, manifestPath: observation.path, manifest };
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`controlled_graph_package_root_unresolved:${expectedName}`);
}

function validateGraphCreationInput(options) {
  const requiredKeys = [
    'trustedRoot',
    'entryRelativePath',
    'entryBytes',
    'moduleEntryPaths',
    'supportFilePaths',
  ];
  const optionalKeys = ['moduleEntries', 'supportEntries'];
  const inspection = inspectBoundedDataRecord(
    options,
    'controlled_graph_input',
    requiredKeys.length + optionalKeys.length,
  );
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  if (
    requiredKeys.some((key) => !inspection.descriptors.has(key))
    || inspection.keys.some((key) => !allowedKeys.has(key))
  ) {
    throw new TypeError('controlled_graph_input_fields_invalid');
  }
  const input = Object.freeze(Object.fromEntries(
    requiredKeys.map((key) => [key, inspection.descriptors.get(key).value]),
  ));
  assertBoundedPathText(input.trustedRoot, 'controlled_graph_trusted_root');
  const entryRelativePath = normalizeRelativePath(
    input.entryRelativePath,
    'controlled_graph_entry_relative_path',
  );
  if (
    utilTypes.isProxy(input.entryBytes)
    || !Buffer.isBuffer(input.entryBytes)
    || input.entryBytes.byteLength === 0
  ) {
    throw new TypeError('controlled_graph_entry_bytes_invalid');
  }
  if (input.entryBytes.byteLength > COLD_EXECUTION_AUTHORITY_LIMITS.graphBytes) {
    throw new TypeError('controlled_graph_entry_bytes_unbounded');
  }
  const entryBytes = Buffer.from(input.entryBytes);
  assertBoundedArray(
    input.moduleEntryPaths,
    COLD_EXECUTION_AUTHORITY_LIMITS.graphRoots,
    'controlled_graph_module_entries',
  );
  assertBoundedArray(
    input.supportFilePaths,
    COLD_EXECUTION_AUTHORITY_LIMITS.graphRoots,
    'controlled_graph_support_files',
  );
  for (const [label, values] of [
    ['controlled_graph_module_entry', input.moduleEntryPaths],
    ['controlled_graph_support_file', input.supportFilePaths],
  ]) {
    for (const value of values) assertBoundedPathText(value, label);
  }
  const moduleEntriesValue = inspection.descriptors.get('moduleEntries')?.value ?? [];
  assertBoundedArray(
    moduleEntriesValue,
    COLD_EXECUTION_AUTHORITY_LIMITS.graphRoots,
    'controlled_graph_inline_module_entries',
  );
  const moduleEntryPaths = new Set();
  let moduleEntryByteLength = 0;
  const moduleEntries = Object.freeze(moduleEntriesValue.map((value) => {
    const entry = assertExactRecord(
      value,
      ['relativePath', 'bytes'],
      'controlled_graph_module_entry',
    );
    const relativePath = normalizeRelativePath(
      entry.relativePath,
      'controlled_graph_module_entry_relative_path',
    );
    if (relativePath === entryRelativePath) {
      throw new TypeError('controlled_graph_module_entry_path_collision');
    }
    if (moduleEntryPaths.has(relativePath)) {
      throw new TypeError('controlled_graph_module_entry_path_duplicated');
    }
    moduleEntryPaths.add(relativePath);
    if (!Buffer.isBuffer(entry.bytes) || utilTypes.isProxy(entry.bytes)) {
      throw new TypeError('controlled_graph_module_entry_bytes_invalid');
    }
    moduleEntryByteLength += entry.bytes.byteLength;
    if (moduleEntryByteLength > COLD_EXECUTION_AUTHORITY_LIMITS.graphBytes) {
      throw new TypeError('controlled_graph_module_entry_bytes_unbounded');
    }
    return Object.freeze({
      relativePath,
      bytes: Buffer.from(entry.bytes),
    });
  }));
  const supportEntriesValue = inspection.descriptors.get('supportEntries')?.value ?? [];
  assertBoundedArray(
    supportEntriesValue,
    COLD_EXECUTION_AUTHORITY_LIMITS.graphRoots,
    'controlled_graph_support_entries',
  );
  const supportEntries = Object.freeze(supportEntriesValue.map((value) => {
    const entry = assertExactRecord(
      value,
      ['relativePath', 'bytes'],
      'controlled_graph_support_entry',
    );
    const relativePath = normalizeRelativePath(
      entry.relativePath,
      'controlled_graph_support_entry_relative_path',
    );
    if (!Buffer.isBuffer(entry.bytes) || utilTypes.isProxy(entry.bytes)) {
      throw new TypeError('controlled_graph_support_entry_bytes_invalid');
    }
    return Object.freeze({
      relativePath,
      bytes: Buffer.from(entry.bytes),
    });
  }));
  return Object.freeze({
    ...input,
    entryRelativePath,
    entryBytes,
    moduleEntries,
    supportEntries,
  });
}

export async function createControlledExecutionGraph(options) {
  const input = validateGraphCreationInput(options);
  const { entryRelativePath } = input;
  const trustedRoot = await verifiedTrustedRoot(
    input.trustedRoot,
    'controlled_graph',
  );
  const entryReferencePath = path.resolve(
    trustedRoot,
    ...entryRelativePath.split('/'),
  );
  if (!isInsideDirectory(trustedRoot, entryReferencePath)) {
    throw new Error('controlled_graph_entry_escaped_trusted_root');
  }

  const files = new Map();
  const graphPathIdentities = new Map();
  const entryRequest = Object.freeze({
    sourcePath: null,
    referencePath: entryReferencePath,
    relativePath: entryRelativePath,
    bytes: Buffer.from(input.entryBytes),
    role: 'generated_ecmascript_entry',
  });
  const virtualModules = new Map([[
    filesystemPathKey(entryReferencePath),
    entryRequest,
  ]]);
  const moduleQueue = [entryRequest];
  for (const moduleEntry of input.moduleEntries) {
    const referencePath = path.resolve(
      trustedRoot,
      ...moduleEntry.relativePath.split('/'),
    );
    if (!isInsideDirectory(trustedRoot, referencePath)) {
      throw new Error('controlled_graph_module_entry_escaped_trusted_root');
    }
    if (sameFilesystemPath(referencePath, entryReferencePath)) {
      throw new Error('controlled_graph_module_entry_path_collision');
    }
    try {
      await lstat(referencePath);
      throw new Error('controlled_graph_module_entry_source_collision');
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
    const referenceKey = filesystemPathKey(referencePath);
    if (virtualModules.has(referenceKey)) {
      throw new Error('controlled_graph_module_entry_path_duplicated');
    }
    const request = Object.freeze({
      sourcePath: null,
      referencePath,
      relativePath: moduleEntry.relativePath,
      bytes: moduleEntry.bytes,
      role: 'ecmascript_module_root',
    });
    virtualModules.set(referenceKey, request);
    moduleQueue.push(request);
  }
  for (const modulePath of input.moduleEntryPaths) {
    moduleQueue.push({ sourcePath: path.resolve(modulePath), role: 'ecmascript_module_root' });
  }
  const moduleSeen = new Set();
  const packageQueue = [];
  const packageSeen = new Set();
  let totalBytes = 0;

  const addBytes = ({ sourcePath = null, relativePath, bytes, role }) => {
    const graphPathKey = filesystemPathKey(path.resolve(
      trustedRoot,
      ...relativePath.split('/'),
    ));
    const existingRelativePath = graphPathIdentities.get(graphPathKey);
    if (
      existingRelativePath !== undefined
      && existingRelativePath !== relativePath
    ) {
      throw new Error(`controlled_graph_filesystem_path_collision:${relativePath}`);
    }
    if (files.has(relativePath)) {
      const previous = files.get(relativePath);
      const previousIsMemoryBacked = previous.sourcePath === null;
      const nextIsMemoryBacked = sourcePath === null;
      if (
        previousIsMemoryBacked !== nextIsMemoryBacked
        || (
          !previousIsMemoryBacked
          && !sameFilesystemPath(previous.sourcePath, sourcePath)
        )
      ) {
        throw new Error(`controlled_graph_path_provenance_collision:${relativePath}`);
      }
      if (previous.contentHash !== byteHash(bytes)) {
        throw new Error(`controlled_graph_relative_path_collision:${relativePath}`);
      }
      return previous;
    }
    totalBytes += bytes.byteLength;
    if (
      files.size + 1 > COLD_EXECUTION_AUTHORITY_LIMITS.graphFiles
      || totalBytes > COLD_EXECUTION_AUTHORITY_LIMITS.graphBytes
    ) throw new Error('controlled_graph_size_limit_exceeded');
    const entry = {
      sourcePath,
      relativePath,
      role,
      contentHash: byteHash(bytes),
      byteLength: bytes.byteLength,
      bytes: Buffer.from(bytes),
      imports: [],
    };
    files.set(relativePath, entry);
    graphPathIdentities.set(graphPathKey, relativePath);
    return entry;
  };

  const addFile = async (filePath, role) => {
    const observation = await readVerifiedRegularFile(path.resolve(filePath), {
      trustedRoot,
      label: 'controlled_graph_file',
    });
    const relativePath = relativePathInside(
      trustedRoot,
      observation.path,
      'controlled_graph_file',
    );
    return addBytes({
      sourcePath: observation.path,
      relativePath,
      bytes: observation.bytes,
      role,
    });
  };

  while (moduleQueue.length > 0) {
    const request = moduleQueue.shift();
    let referencePath;
    let entry;
    if (request.sourcePath === null) {
      referencePath = request.referencePath;
      const moduleKey = filesystemPathKey(referencePath);
      if (moduleSeen.has(moduleKey)) continue;
      moduleSeen.add(moduleKey);
      entry = addBytes(request);
    } else {
      const resolved = await realpath(path.resolve(request.sourcePath));
      if (!isInsideDirectory(trustedRoot, resolved)) {
        throw new Error('controlled_graph_module_escaped_trusted_root');
      }
      const moduleKey = filesystemPathKey(resolved);
      if (virtualModules.has(moduleKey)) {
        throw new Error('controlled_graph_module_root_source_collision');
      }
      if (moduleSeen.has(moduleKey)) continue;
      moduleSeen.add(moduleKey);
      referencePath = resolved;
      entry = await addFile(resolved, request.role ?? 'ecmascript_module');
    }
    if (!['.js', '.mjs', '.cjs'].includes(path.extname(referencePath).toLowerCase())) {
      throw new Error(`controlled_graph_module_extension_unsupported:${entry.relativePath}`);
    }

    let packageScope = path.dirname(referencePath);
    while (isInsideDirectory(trustedRoot, packageScope)) {
      const packageManifestPath = path.join(packageScope, 'package.json');
      try {
        const packageManifestEntry = await addFile(
          packageManifestPath,
          'module_scope_metadata',
        );
        entry.imports.push({
          specifier: '<package-scope>',
          kind: 'module_scope_metadata',
          resolution: packageManifestEntry.relativePath,
        });
        break;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
      }
      const parent = path.dirname(packageScope);
      if (parent === packageScope) break;
      packageScope = parent;
    }

    const parsed = parseJavaScriptDependencies(
      new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes),
      referencePath,
    );
    if (parsed.unsupportedDynamicLoads.length > 0) {
      throw new Error(
        `controlled_graph_untracked_dynamic_import:${entry.relativePath}:${parsed.unsupportedDynamicLoads.join(',')}`,
      );
    }
    if (parsed.prohibitedEscapePaths.length > 0) {
      throw new Error(
        `controlled_graph_alternate_loader_refused:${entry.relativePath}:${parsed.prohibitedEscapePaths.join(',')}`,
      );
    }
    const resolver = createRequire(pathToFileURL(referencePath));
    for (const dependency of parsed.dependencies) {
      const specifier = dependency.specifier;
      if (NODE_BUILTIN_MODULES.has(specifier)) {
        entry.imports.push({ specifier, kind: dependency.kind, resolution: 'node_builtin' });
        continue;
      }
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:')) {
        const dependencyPath = specifier.startsWith('file:')
          ? fileURLToPath(new URL(specifier))
          : specifier.startsWith('.')
            ? path.resolve(path.dirname(referencePath), specifier)
            : path.resolve(specifier);
        if (!isInsideDirectory(trustedRoot, dependencyPath)) {
          throw new Error(`controlled_graph_local_import_escaped:${specifier}`);
        }
        const virtualDependency = virtualModules.get(filesystemPathKey(dependencyPath));
        if (virtualDependency) {
          entry.imports.push({
            specifier,
            kind: dependency.kind,
            resolution: virtualDependency.relativePath,
          });
          moduleQueue.push({
            ...virtualDependency,
            role: 'ecmascript_module',
          });
          continue;
        }
        const dependencyResolved = await realpath(dependencyPath);
        if (!isInsideDirectory(trustedRoot, dependencyResolved)) {
          throw new Error(`controlled_graph_local_import_escaped:${specifier}`);
        }
        const dependencyRelativePath = relativePathInside(
          trustedRoot,
          dependencyResolved,
          'controlled_graph_dependency',
        );
        entry.imports.push({
          specifier,
          kind: dependency.kind,
          resolution: dependencyRelativePath,
        });
        moduleQueue.push({ sourcePath: dependencyResolved, role: 'ecmascript_module' });
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      let externalResolved;
      try {
        externalResolved = resolver.resolve(specifier);
      } catch {
        throw new Error(`controlled_graph_external_import_unresolved:${specifier}`);
      }
      const packageInfo = await packageRootForResolvedModule(
        trustedRoot,
        externalResolved,
        packageName,
      );
      entry.imports.push({
        specifier,
        kind: dependency.kind,
        resolution: relativePathInside(
          trustedRoot,
          externalResolved,
          'controlled_graph_package_entry',
        ),
        packageName,
      });
      packageQueue.push(packageInfo);
      moduleQueue.push({
        sourcePath: externalResolved,
        role: 'external_package_module',
      });
    }
  }

  while (packageQueue.length > 0) {
    const packageInfo = packageQueue.shift();
    const packageRoot = await realpath(packageInfo.root);
    if (!isInsideDirectory(trustedRoot, packageRoot)) {
      throw new Error('controlled_graph_package_escaped_trusted_root');
    }
    if (packageSeen.has(packageRoot)) continue;
    packageSeen.add(packageRoot);
    const pendingDirectories = [packageRoot];
    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.shift();
      const directoryMetadata = await lstat(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
        throw new Error('controlled_graph_package_directory_linked');
      }
      if (!sameFilesystemPath(directory, await realpath(directory))) {
        throw new Error('controlled_graph_package_directory_junction_refused');
      }
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => Buffer.compare(
        Buffer.from(left.name, 'utf8'),
        Buffer.from(right.name, 'utf8'),
      ));
      for (const child of children) {
        const childPath = path.join(directory, child.name);
        if (child.isSymbolicLink()) {
          throw new Error('controlled_graph_package_symlink_refused');
        }
        if (child.isDirectory()) pendingDirectories.push(childPath);
        else if (child.isFile()) await addFile(childPath, 'external_package_file');
        else throw new Error('controlled_graph_package_special_file_refused');
      }
    }
    const requiredDependencies = isPlainRecord(packageInfo.manifest.dependencies)
      ? packageInfo.manifest.dependencies
      : {};
    const optionalDependencies = isPlainRecord(packageInfo.manifest.optionalDependencies)
      ? packageInfo.manifest.optionalDependencies
      : {};
    const resolver = createRequire(pathToFileURL(packageInfo.manifestPath));
    for (const dependencyName of Object.keys({
      ...requiredDependencies,
      ...optionalDependencies,
    }).sort()) {
      try {
        let resolvedDependency = null;
        for (const specifier of [
          dependencyName,
          `${dependencyName}/package`,
          `${dependencyName}/package.json`,
        ]) {
          try {
            resolvedDependency = resolver.resolve(specifier);
            break;
          } catch {
            // Some packages expose metadata but no root entry.
          }
        }
        if (!resolvedDependency) throw new Error('package entry unresolved');
        packageQueue.push(await packageRootForResolvedModule(
          trustedRoot,
          resolvedDependency,
          dependencyName,
        ));
      } catch {
        if (Object.hasOwn(requiredDependencies, dependencyName)) {
          throw new Error(`controlled_graph_package_dependency_unresolved:${dependencyName}`);
        }
      }
    }
  }

  for (const supportFilePath of input.supportFilePaths) {
    await addFile(path.resolve(supportFilePath), 'support_input');
  }
  for (const supportEntry of input.supportEntries) {
    if (files.has(supportEntry.relativePath)) {
      throw new Error(
        `controlled_graph_support_entry_path_collision:${supportEntry.relativePath}`,
      );
    }
    addBytes({
      sourcePath: null,
      relativePath: supportEntry.relativePath,
      bytes: supportEntry.bytes,
      role: 'support_input',
    });
  }

  const manifestEntries = Object.freeze([...files.values()]
    .map((entry) => Object.freeze({
      relativePath: entry.relativePath,
      role: entry.role,
      contentHash: entry.contentHash,
      byteLength: entry.byteLength,
      imports: Object.freeze(entry.imports.map((dependency) => Object.freeze({
        ...dependency,
      }))),
    }))
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.relativePath, 'utf8'),
      Buffer.from(right.relativePath, 'utf8'),
    )));
  const manifestSeed = {
    schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.controlledGraph,
    graphKind: 'static_ecmascript_support_graph',
    graphCompletenessClaim: 'static_resolution_support_only',
    supportEvidenceOnly: true,
    loadedGraphIdentityAttested: false,
    entryPath: entryRelativePath,
    entries: manifestEntries,
  };
  const graphHash = valueHash(manifestSeed);
  const graph = Object.freeze({ ...manifestSeed, graphHash });
  const materialParentRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-execution-graph-'),
  );
  const materialRoot = path.join(
    materialParentRoot,
    graphHash.replace('sha256:', 'sha256-'),
  );
  await mkdir(materialRoot, { recursive: false, mode: 0o700 });
  try {
    for (const entry of files.values()) {
      const materialPath = path.join(materialRoot, ...entry.relativePath.split('/'));
      await mkdir(path.dirname(materialPath), { recursive: true });
      const handle = await open(materialPath, 'wx', 0o400);
      try {
        await handle.writeFile(entry.bytes);
      } finally {
        await handle.close();
      }
      await chmod(materialPath, 0o400).catch(() => {});
    }
  } catch (error) {
    await rm(materialParentRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  controlledGraphBrand.set(graph, Object.freeze({
    trustedRoot,
    materialRoot,
    materialParentRoot,
    files: new Map([...files.values()].map((entry) => [entry.relativePath, {
      contentHash: entry.contentHash,
      byteLength: entry.byteLength,
    }])),
    registeredOutputs: new Map(),
    executionState: {
      prebound: false,
      registeredOutputsHash: null,
    },
  }));
  return graph;
}

function graphAllowedDirectories(relativePaths) {
  const directories = new Set();
  for (const relativePath of relativePaths) {
    let directory = path.posix.dirname(relativePath);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return directories;
}

export async function verifyControlledExecutionGraph(graph, { requireOutputs = false } = {}) {
  const brand = controlledGraphBrand.get(graph);
  if (!brand || graph?.schemaVersion !== COLD_EXECUTION_AUTHORITY_SCHEMAS.controlledGraph) {
    return false;
  }
  try {
    const allowedFiles = new Set([
      ...brand.files.keys(),
      ...brand.registeredOutputs.keys(),
    ]);
    const allowedDirectories = graphAllowedDirectories(allowedFiles);
    const actualFiles = new Set();
    const pending = [brand.materialRoot];
    while (pending.length > 0) {
      const directory = pending.pop();
      const directoryMetadata = await lstat(directory);
      if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) return false;
      if (!sameFilesystemPath(directory, await realpath(directory))) return false;
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        const childPath = path.join(directory, child.name);
        const metadata = await lstat(childPath);
        if (metadata.isSymbolicLink()) return false;
        const relativePath = path.relative(brand.materialRoot, childPath).replace(/\\/g, '/');
        if (metadata.isDirectory()) {
          if (!allowedDirectories.has(relativePath)) return false;
          pending.push(childPath);
          continue;
        }
        if (!metadata.isFile()) return false;
        actualFiles.add(relativePath);
      }
    }
    if ([...actualFiles].some((relativePath) => !allowedFiles.has(relativePath))) return false;
    for (const [relativePath, expected] of brand.files) {
      if (!actualFiles.has(relativePath)) return false;
      const observation = await readVerifiedRegularFile(
        path.join(brand.materialRoot, ...relativePath.split('/')),
        {
          trustedRoot: brand.materialRoot,
          label: 'controlled_graph_materialized_file',
        },
      );
      if (
        observation.byteLength !== expected.byteLength
        || observation.hash !== expected.contentHash
      ) return false;
    }
    if (
      requireOutputs
      && [...brand.registeredOutputs.keys()].some((relativePath) =>
        !actualFiles.has(relativePath))
    ) return false;
    for (const relativePath of brand.registeredOutputs.keys()) {
      if (!actualFiles.has(relativePath)) continue;
      await readVerifiedRegularFile(
        path.join(brand.materialRoot, ...relativePath.split('/')),
        {
          trustedRoot: brand.materialRoot,
          allowEmpty: false,
          label: 'controlled_graph_observed_output',
        },
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function controlledExecutionGraphMaterialPath(graph, sourcePath) {
  const brand = controlledGraphBrand.get(graph);
  if (!brand) return null;
  const relativePath = relativePathInside(brand.trustedRoot, sourcePath, 'controlled_graph_source');
  if (!brand.files.has(relativePath)) return null;
  return path.join(brand.materialRoot, ...relativePath.split('/'));
}

export function controlledExecutionGraphEntryPath(graph) {
  const brand = controlledGraphBrand.get(graph);
  if (!brand || !brand.files.has(graph.entryPath)) return null;
  return path.join(brand.materialRoot, ...graph.entryPath.split('/'));
}

export function registerControlledExecutionOutput(graph, sourcePath) {
  const brand = controlledGraphBrand.get(graph);
  if (!brand) return null;
  const relativePath = relativePathInside(brand.trustedRoot, sourcePath, 'controlled_graph_output');
  if (brand.files.has(relativePath)) return null;
  const materialPath = path.join(brand.materialRoot, ...relativePath.split('/'));
  if (brand.registeredOutputs.has(relativePath)) return materialPath;
  if (brand.executionState.prebound === true) {
    throw new Error('controlled_graph_output_registration_closed');
  }
  if (brand.registeredOutputs.size >= COLD_EXECUTION_AUTHORITY_LIMITS.graphOutputs) {
    throw new Error('controlled_graph_output_limit_exceeded');
  }
  brand.registeredOutputs.set(relativePath, Object.freeze({
    relativePath,
    role: REGISTERED_GRAPH_RESULT_ROLE,
    materialPathHash: valueHash(path.resolve(materialPath)),
  }));
  return materialPath;
}

function registeredOutputManifest(brand) {
  return [...brand.registeredOutputs.values()]
    .map((registration) => ({
      relativePath: registration.relativePath,
      role: registration.role,
      materialPathHash: registration.materialPathHash,
    }))
    .sort((left, right) => Buffer.compare(
      Buffer.from(left.relativePath, 'utf8'),
      Buffer.from(right.relativePath, 'utf8'),
    ));
}

function registeredOutputsHash(brand) {
  return valueHash({
    role: REGISTERED_GRAPH_RESULT_ROLE,
    outputs: registeredOutputManifest(brand),
  });
}

function verifiedResultReceiptSeed(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    graphHash: receipt.graphHash,
    invocationHash: receipt.invocationHash,
    resultRole: receipt.resultRole,
    resultRelativePath: receipt.resultRelativePath,
    resultPathHash: receipt.resultPathHash,
    registeredOutputsHash: receipt.registeredOutputsHash,
    resultBytesHash: receipt.resultBytesHash,
    resultByteLength: receipt.resultByteLength,
    processResultChannelHash: receipt.processResultChannelHash,
    childPid: receipt.childPid,
    processStartedAt: receipt.processStartedAt,
    processFinishedAt: receipt.processFinishedAt,
    processSessionNonce: receipt.processSessionNonce,
  };
}

export function verifyRegisteredGraphResultReceipt(executionResult, receipt) {
  const receiptBrand = verifiedResultReceiptBrand.get(receipt);
  const observation = processObservationBrand.get(executionResult);
  const context = processExecutionContextBrand.get(executionResult);
  if (
    !receiptBrand
    || !observation
    || !context
    || receiptBrand.executionResult !== executionResult
    || receiptBrand.graph !== context.graph
    || receiptBrand.processObservation !== observation
    || receipt?.schemaVersion !== COLD_EXECUTION_AUTHORITY_SCHEMAS.verifiedResultReceipt
    || !Buffer.isBuffer(receipt.bytes)
    || receipt.bytes.byteLength !== receipt.resultByteLength
    || byteHash(receipt.bytes) !== receipt.resultBytesHash
    || valueHash(verifiedResultReceiptSeed(receipt)) !== receipt.receiptHash
    || receipt.invocationHash !== observation.prelaunchBinding?.invocationHash
    || receipt.registeredOutputsHash
      !== observation.prelaunchBinding?.registeredOutputsHash
    || receipt.processResultChannelHash !== observation.resultChannelHash
  ) return false;
  return true;
}

function mappedExecutableIdentityHash(observation) {
  const binding = observation?.prelaunchBinding;
  const mapped = observation?.spawnedExecutableObservation;
  if (
    binding?.schemaVersion !== COLD_EXECUTION_AUTHORITY_SCHEMAS.executableBinding
    || observation.executableIdentityStable !== true
    || observation.spawnedExecutableIdentityStable !== true
    || mapped?.mappedImageIdentityAttested !== true
    || mapped.contentHash !== binding.executableHash
    || mapped.byteLength !== binding.executableByteLength
    || !sameExecutableFileIdentity(
      binding.preboundFileIdentity,
      mapped.observedFileIdentity,
    )
    || !sameExecutableFileIdentity(
      binding.preboundPathIdentity,
      mapped.observedPathIdentity,
    )
  ) return null;
  return valueHash({
    executableHash: binding.executableHash,
    executableByteLength: binding.executableByteLength,
    executablePathHash: binding.pathHash,
    mappedObservationKind: mapped.observationKind,
    mappedContentHash: mapped.contentHash,
    mappedByteLength: mapped.byteLength,
    mappedPathHash: mapped.pathHash,
    preboundFileIdentity: binding.preboundFileIdentity,
    preboundPathIdentity: binding.preboundPathIdentity,
    observedFileIdentity: mapped.observedFileIdentity,
    observedPathIdentity: mapped.observedPathIdentity,
  });
}

function runtimeEntryConsumptionReceiptSeed(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    mappedExecutableIdentityHash: receipt.mappedExecutableIdentityHash,
    invocationHash: receipt.invocationHash,
    stdinBytesHash: receipt.stdinBytesHash,
    stdinByteLength: receipt.stdinByteLength,
    interpreterMode: receipt.interpreterMode,
    stdinInvocationClassificationHash: receipt.stdinInvocationClassificationHash,
    interpretedEntrySetHash: receipt.interpretedEntrySetHash,
    interpretedEntryCount: receipt.interpretedEntryCount,
    sideLoadedEntryCount: receipt.sideLoadedEntryCount,
    childPid: receipt.childPid,
    processStartedAt: receipt.processStartedAt,
    processFinishedAt: receipt.processFinishedAt,
    processSessionNonce: receipt.processSessionNonce,
    processResultChannelHash: receipt.processResultChannelHash,
  };
}

function exclusiveStdinInterpretedEntrySetHash(stdinBytesHash, stdinByteLength) {
  return valueHash({
    schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.exclusiveStdinInterpretedEntrySet,
    interpreterMode: CANONICAL_EXCLUSIVE_STDIN_INTERPRETER_MODE,
    interpretedEntries: [{
      role: 'exclusive_stdin_entry',
      bytesHash: stdinBytesHash,
      byteLength: stdinByteLength,
    }],
    sideLoadedEntries: [],
  });
}

export function verifyRuntimeEntryConsumptionReceipt(executionResult, receipt) {
  const receiptBrand = runtimeEntryConsumptionReceiptBrand.get(receipt);
  const observation = processObservationBrand.get(executionResult);
  const context = processExecutionContextBrand.get(executionResult);
  if (
    !receiptBrand
    || receiptBrand.issuerKind !== 'trusted_native_runtime_entry_observer'
    || !trustedRuntimeEntryObserverBrand.has(receiptBrand.observerInstance)
    || receiptBrand.executionResult !== executionResult
    || receiptBrand.processObservation !== observation
    || !observation
    || !context
  ) return false;
  let fields;
  try {
    fields = assertExactRecord(receipt, [
      'schemaVersion',
      'receiptHash',
      'mappedExecutableIdentityHash',
      'invocationHash',
      'stdinBytesHash',
      'stdinByteLength',
      'interpreterMode',
      'stdinInvocationClassificationHash',
      'interpretedEntrySetHash',
      'interpretedEntryCount',
      'sideLoadedEntryCount',
      'childPid',
      'processStartedAt',
      'processFinishedAt',
      'processSessionNonce',
      'processResultChannelHash',
    ], 'runtime_entry_consumption_receipt');
  } catch {
    return false;
  }
  const expectedMappedIdentityHash = mappedExecutableIdentityHash(observation);
  const binding = observation.prelaunchBinding;
  let expectedInterpretedEntrySetHash;
  try {
    expectedInterpretedEntrySetHash = exclusiveStdinInterpretedEntrySetHash(
      fields.stdinBytesHash,
      fields.stdinByteLength,
    );
  } catch {
    return false;
  }
  if (
    fields.schemaVersion
      !== COLD_EXECUTION_AUTHORITY_SCHEMAS.runtimeEntryConsumptionReceipt
    || fields.interpreterMode !== CANONICAL_EXCLUSIVE_STDIN_INTERPRETER_MODE
    || !CANONICAL_SHA256_PATTERN.test(fields.receiptHash ?? '')
    || !CANONICAL_SHA256_PATTERN.test(fields.mappedExecutableIdentityHash ?? '')
    || !CANONICAL_SHA256_PATTERN.test(fields.invocationHash ?? '')
    || !CANONICAL_SHA256_PATTERN.test(fields.stdinBytesHash ?? '')
    || !CANONICAL_SHA256_PATTERN.test(fields.stdinInvocationClassificationHash ?? '')
    || !CANONICAL_SHA256_PATTERN.test(fields.interpretedEntrySetHash ?? '')
    || !CANONICAL_SHA256_PATTERN.test(fields.processResultChannelHash ?? '')
    || !Number.isSafeInteger(fields.stdinByteLength)
    || fields.stdinByteLength <= 0
    || fields.interpretedEntryCount !== 1
    || fields.sideLoadedEntryCount !== 0
    || !Number.isSafeInteger(fields.childPid)
    || fields.childPid <= 0
    || typeof fields.processStartedAt !== 'string'
    || fields.processStartedAt !== observation.startedAt
    || typeof fields.processFinishedAt !== 'string'
    || fields.processFinishedAt !== observation.finishedAt
    || typeof fields.processSessionNonce !== 'string'
    || fields.processSessionNonce !== observation.sessionNonce
    || expectedMappedIdentityHash === null
    || fields.mappedExecutableIdentityHash !== expectedMappedIdentityHash
    || fields.invocationHash !== binding?.invocationHash
    || isCanonicalExclusiveStdinInvocationBinding(binding) !== true
    || fields.stdinInvocationClassificationHash
      !== binding?.stdinEntryInvocationClassificationHash
    || fields.interpretedEntrySetHash !== expectedInterpretedEntrySetHash
    || fields.stdinBytesHash !== binding?.entryBytesHash
    || fields.stdinBytesHash !== binding?.stdinBytesHash
    || fields.stdinByteLength !== binding?.entryByteLength
    || fields.stdinByteLength !== binding?.stdinByteLength
    || fields.childPid !== observation.childPid
    || fields.processResultChannelHash !== observation.resultChannelHash
    || observation.processChannelCaptured !== true
    || context.authorityKind !== 'stdin_entry_bytes'
    || valueHash(runtimeEntryConsumptionReceiptSeed(fields)) !== fields.receiptHash
    || receiptBrand.mappedExecutableIdentityHash !== expectedMappedIdentityHash
    || receiptBrand.entryBytesObservedAsExecuted !== true
    || receiptBrand.exclusiveEntryExecutionObserved !== true
    || receiptBrand.sideLoadedCodeAbsent !== true
    || receiptBrand.resultChannelObservedAfterEntry !== true
    || receiptBrand.invocationHash !== fields.invocationHash
    || receiptBrand.stdinBytesHash !== fields.stdinBytesHash
    || receiptBrand.stdinByteLength !== fields.stdinByteLength
    || receiptBrand.interpreterMode !== fields.interpreterMode
    || receiptBrand.stdinInvocationClassificationHash
      !== fields.stdinInvocationClassificationHash
    || receiptBrand.interpretedEntrySetHash !== fields.interpretedEntrySetHash
    || receiptBrand.interpretedEntryCount !== 1
    || receiptBrand.sideLoadedEntryCount !== 0
    || receiptBrand.childPid !== fields.childPid
    || receiptBrand.processSessionNonce !== fields.processSessionNonce
    || receiptBrand.processResultChannelHash !== fields.processResultChannelHash
    || receiptBrand.receiptHash !== fields.receiptHash
  ) return false;
  return true;
}

export async function readRegisteredGraphResultReceipt(input) {
  const fields = assertExactRecord(
    input,
    ['executionResult', 'graph', 'resultPath'],
    'registered_graph_result_receipt_input',
  );
  const graphBrand = controlledGraphBrand.get(fields.graph);
  const observation = processObservationBrand.get(fields.executionResult);
  const context = processExecutionContextBrand.get(fields.executionResult);
  if (
    !graphBrand
    || !observation
    || !context
    || context.authorityKind !== 'controlled_ecmascript_graph'
    || context.graph !== fields.graph
    || observation.executionGraphHash !== fields.graph.graphHash
    || observation.executionGraphStable !== true
    || observation.processChannelCaptured !== true
    || graphBrand.executionState.prebound !== true
    || graphBrand.executionState.registeredOutputsHash
      !== observation.prelaunchBinding?.registeredOutputsHash
    || registeredOutputsHash(graphBrand)
      !== observation.prelaunchBinding?.registeredOutputsHash
  ) return null;
  const requestedPath = path.resolve(fields.resultPath);
  if (!isInsideDirectory(graphBrand.materialRoot, requestedPath)) return null;
  const relativePath = path.relative(graphBrand.materialRoot, requestedPath).replace(/\\/g, '/');
  const registration = graphBrand.registeredOutputs.get(relativePath);
  if (
    !registration
    || registration.role !== REGISTERED_GRAPH_RESULT_ROLE
    || registration.materialPathHash !== valueHash(requestedPath)
  ) return null;
  if (await verifyControlledExecutionGraph(fields.graph, { requireOutputs: true }) !== true) {
    return null;
  }
  let resultObservation;
  try {
    resultObservation = await readVerifiedRegularFile(requestedPath, {
      trustedRoot: graphBrand.materialRoot,
      allowEmpty: false,
      label: 'registered_graph_result_receipt',
    });
  } catch {
    return null;
  }
  if (
    await verifyControlledExecutionGraph(fields.graph, { requireOutputs: true }) !== true
    || await verifyPreviouslyReadRegularFile(resultObservation) !== true
  ) return null;
  const receiptSeed = {
    schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.verifiedResultReceipt,
    graphHash: fields.graph.graphHash,
    invocationHash: observation.prelaunchBinding.invocationHash,
    resultRole: registration.role,
    resultRelativePath: registration.relativePath,
    resultPathHash: registration.materialPathHash,
    registeredOutputsHash: observation.prelaunchBinding.registeredOutputsHash,
    resultBytesHash: resultObservation.hash,
    resultByteLength: resultObservation.byteLength,
    processResultChannelHash: observation.resultChannelHash,
    childPid: observation.childPid,
    processStartedAt: observation.startedAt,
    processFinishedAt: observation.finishedAt,
    processSessionNonce: observation.sessionNonce,
  };
  const receipt = Object.freeze({
    ...receiptSeed,
    receiptHash: valueHash(receiptSeed),
    bytes: Buffer.from(resultObservation.bytes),
  });
  verifiedResultReceiptBrand.set(receipt, Object.freeze({
    executionResult: fields.executionResult,
    graph: fields.graph,
    processObservation: observation,
    resultObservation,
  }));
  return receipt;
}

export function controlledExecutionGraphRoot(graph) {
  return controlledGraphBrand.get(graph)?.materialRoot ?? null;
}

export function loadControlledExecutionPackage() {
  return null;
}

export async function removeControlledExecutionGraph(graph) {
  const brand = controlledGraphBrand.get(graph);
  if (!brand) return false;
  controlledGraphBrand.delete(graph);
  try {
    await rm(brand.materialParentRoot, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function validateProcessArguments(command, args) {
  assertBoundedPathText(command, 'process_command');
  assertBoundedArray(args, COLD_EXECUTION_AUTHORITY_LIMITS.processArguments, 'process_arguments');
  const normalized = args.map((value) => String(value));
  const byteLength = normalized.reduce(
    (total, value) => total + Buffer.byteLength(value, 'utf8'),
    0,
  );
  if (byteLength > COLD_EXECUTION_AUTHORITY_LIMITS.processArgumentBytes) {
    throw new TypeError('process_arguments_size_limit_exceeded');
  }
  return normalized;
}

function sideLoadEnvironmentMechanic(name) {
  const canonicalName = name.toUpperCase();
  if (SIDE_LOAD_ENVIRONMENT_NAMES.has(canonicalName)) {
    return canonicalName.startsWith('NODE_')
      ? 'runtime_module_injection_environment'
      : 'loader_or_runtime_injection_environment';
  }
  if (/^(?:OPENSSL_|SSL_CERT_)/.test(canonicalName)) {
    return 'native_provider_or_config_injection_environment';
  }
  if (/^(?:DYLD|LD)_/.test(canonicalName)) {
    return 'native_loader_injection_environment';
  }
  return null;
}

function environmentSnapshotFromEntries(entries) {
  const frozenEntries = Object.freeze(entries.map(({ name, value }) => Object.freeze({
    name,
    value,
  })));
  return Object.freeze({
    entries: frozenEntries,
    environment: Object.freeze(Object.fromEntries(
      frozenEntries.map(({ name, value }) => [name, value]),
    )),
    hash: valueHash({ entries: frozenEntries }),
  });
}

function snapshotAuthorityEnvironment(environment) {
  if (
    environment === null
    || typeof environment !== 'object'
    || Array.isArray(environment)
    || utilTypes.isProxy(environment)
  ) throw new TypeError('process_environment_not_data_record');
  const ownKeys = Reflect.ownKeys(environment);
  if (ownKeys.length > COLD_EXECUTION_AUTHORITY_LIMITS.environmentEntries) {
    throw new TypeError('process_environment_entries_unbounded');
  }
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError('process_environment_symbol_name_refused');
  }
  const seenCanonicalNames = new Set();
  const entries = [];
  let totalBytes = 0;
  for (const name of ownKeys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(environment, name);
    if (
      !descriptor
      || !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true
      || typeof descriptor.value !== 'string'
      || name.length === 0
      || name.includes('\0')
      || descriptor.value.includes('\0')
      || Buffer.byteLength(name, 'utf8') > COLD_EXECUTION_AUTHORITY_LIMITS.pathBytes
    ) throw new TypeError('process_environment_field_invalid');
    const canonicalName = name.toUpperCase();
    if (seenCanonicalNames.has(canonicalName)) {
      throw new TypeError('process_environment_case_alias_refused');
    }
    seenCanonicalNames.add(canonicalName);
    totalBytes += Buffer.byteLength(name, 'utf8')
      + Buffer.byteLength(descriptor.value, 'utf8');
    if (totalBytes > COLD_EXECUTION_AUTHORITY_LIMITS.environmentBytes) {
      throw new TypeError('process_environment_bytes_unbounded');
    }
    entries.push({ name, value: descriptor.value });
  }
  entries.sort((left, right) => Buffer.compare(
    Buffer.from(left.name, 'utf8'),
    Buffer.from(right.name, 'utf8'),
  ));
  return environmentSnapshotFromEntries(entries);
}

function sanitizedAuthorityEnvironment(snapshot) {
  return environmentSnapshotFromEntries(snapshot.entries.filter(
    ({ name }) => sideLoadEnvironmentMechanic(name) === null,
  ));
}

function sideLoadArgumentMechanic(argument) {
  const equalsIndex = argument.startsWith('--') ? argument.indexOf('=') : -1;
  const canonicalArgument = argument.startsWith('--')
    ? `${(equalsIndex === -1 ? argument : argument.slice(0, equalsIndex))
      .replaceAll('_', '-')}${equalsIndex === -1 ? '' : argument.slice(equalsIndex)}`
    : argument;
  if (
    /^--(?:eval)(?:=|$)/.test(canonicalArgument)
    || /^-e(?:.|$)/s.test(canonicalArgument)
  ) {
    return 'alternate_eval_entry_argument';
  }
  if (
    /^--(?:print)(?:=|$)/.test(canonicalArgument)
    || /^-p(?:.|$)/s.test(canonicalArgument)
  ) {
    return 'alternate_print_entry_argument';
  }
  if (
    /^--(?:require)(?:=|$)/.test(canonicalArgument)
    || /^-r(?:.|$)/s.test(canonicalArgument)
  ) {
    return 'runtime_require_side_load_argument';
  }
  if (/^--import(?:=|$)/.test(canonicalArgument)) {
    return 'runtime_import_side_load_argument';
  }
  if (/^--(?:experimental-)?loader(?:=|$)/.test(canonicalArgument)) {
    return 'runtime_loader_side_load_argument';
  }
  if (
    /^--(?:no-)?openssl-[a-z0-9][a-z0-9-]*(?:=|$)/
      .test(canonicalArgument)
    || /^--(?:enable-fips|force-fips|use-openssl-ca|use-system-ca|use-bundled-ca)(?:=|$)/
      .test(canonicalArgument)
  ) {
    return 'native_provider_or_config_side_load_argument';
  }
  if (
    /^--(?:experimental-policy|policy-integrity)(?:=|$)/.test(canonicalArgument)
  ) {
    return 'runtime_policy_manifest_side_load_argument';
  }
  if (
    /^--(?:snapshot[-_]blob|startup[-_]blob|build-snapshot|build-snapshot-config|experimental-sea-config)(?:=|$)/
      .test(canonicalArgument)
  ) {
    return 'runtime_snapshot_or_startup_blob_side_load_argument';
  }
  if (
    /^--(?:env-file|env-file-if-exists|experimental-config-file|experimental-default-config-file|icu-data-dir|localstorage-file)(?:=|$)/
      .test(canonicalArgument)
  ) {
    return 'external_pre_entry_config_side_load_argument';
  }
  if (
    /^--run(?:=|$)/.test(canonicalArgument)
    || /^--(?:experimental-)?test(?:[-=]|$)/.test(canonicalArgument)
    || /^--watch(?:[-=]|$)/.test(canonicalArgument)
    || /^--entry-url(?:=|$)/.test(canonicalArgument)
  ) {
    return 'alternate_discovered_entry_argument';
  }
  if (
    /^--inspect(?:[-=]|$)/.test(canonicalArgument)
    || /^--debug(?:[-=]|$)/.test(canonicalArgument)
  ) {
    return 'external_pre_entry_control_argument';
  }
  return null;
}

function classifyStdinEntryInvocation(args, requestedEnvironment) {
  const argumentSideLoadMechanics = [...new Set(
    args.map(sideLoadArgumentMechanic).filter(Boolean),
  )].sort();
  const environmentSideLoadNames = requestedEnvironment.entries
    .filter(({ name }) => sideLoadEnvironmentMechanic(name) !== null)
    .map(({ name }) => name.toUpperCase())
    .sort();
  const sideLoadArgumentsAbsent = argumentSideLoadMechanics.length === 0;
  const sideLoadEnvironmentAbsent = environmentSideLoadNames.length === 0;
  return Object.freeze({
    schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.stdinEntryInvocationClassification,
    supportEvidenceOnly: true,
    canonicalInterpreterMode: CANONICAL_EXCLUSIVE_STDIN_INTERPRETER_MODE,
    sideLoadArgumentsAbsent,
    sideLoadEnvironmentAbsent,
    exclusiveStdinEntryCandidate:
      sideLoadArgumentsAbsent && sideLoadEnvironmentAbsent,
    argumentSideLoadMechanics: Object.freeze(argumentSideLoadMechanics),
    environmentSideLoadNames: Object.freeze(environmentSideLoadNames),
    gap: sideLoadArgumentsAbsent && sideLoadEnvironmentAbsent
      ? null
      : 'stdin_entry_side_load_path_present',
  });
}

function isCanonicalExclusiveStdinInvocationBinding(binding) {
  const classification = binding?.stdinEntryInvocationClassification;
  return Boolean(
    binding?.entryDelivery === 'stdin_entry_bytes'
    && CANONICAL_SHA256_PATTERN.test(binding.requestedEnvironmentHash ?? '')
    && binding.requestedEnvironmentHash === binding.executionEnvironmentHash
    && classification?.schemaVersion
      === COLD_EXECUTION_AUTHORITY_SCHEMAS.stdinEntryInvocationClassification
    && classification.supportEvidenceOnly === true
    && classification.canonicalInterpreterMode
      === CANONICAL_EXCLUSIVE_STDIN_INTERPRETER_MODE
    && classification.sideLoadArgumentsAbsent === true
    && classification.sideLoadEnvironmentAbsent === true
    && classification.exclusiveStdinEntryCandidate === true
    && Array.isArray(classification.argumentSideLoadMechanics)
    && classification.argumentSideLoadMechanics.length === 0
    && Array.isArray(classification.environmentSideLoadNames)
    && classification.environmentSideLoadNames.length === 0
    && classification.gap === null
    && valueHash(classification) === binding.stdinEntryInvocationClassificationHash
  );
}

function validateExecutionAuthority(executionAuthority) {
  if (executionAuthority === null || executionAuthority === undefined) return null;
  const inspection = inspectBoundedDataRecord(
    executionAuthority,
    'execution_authority',
    3,
  );
  const stdinKeys = ['entryBytes', 'kind'];
  const graphKeys = ['entryPath', 'graph', 'kind'];
  let authority;
  if (
    inspection.keys.length === stdinKeys.length
    && inspection.keys.every((key, index) => key === stdinKeys[index])
  ) {
    authority = exactRecordValues(
      inspection,
      ['kind', 'entryBytes'],
      'stdin_entry_execution_authority',
    );
  } else if (
    inspection.keys.length === graphKeys.length
    && inspection.keys.every((key, index) => key === graphKeys[index])
  ) {
    authority = exactRecordValues(
      inspection,
      ['kind', 'graph', 'entryPath'],
      'controlled_graph_execution_authority',
    );
  } else {
    throw new TypeError('execution_authority_fields_invalid');
  }
  if (!AUTHORITY_KINDS.has(authority.kind)) {
    throw new TypeError('execution_authority_kind_invalid');
  }
  if (authority.kind === 'stdin_entry_bytes') {
    if (!Buffer.isBuffer(authority.entryBytes)
      || authority.entryBytes.byteLength === 0
      || authority.entryBytes.byteLength > COLD_EXECUTION_AUTHORITY_LIMITS.graphBytes) {
      throw new TypeError('stdin_entry_execution_authority_bytes_invalid');
    }
    return Object.freeze({
      kind: authority.kind,
      entryBytes: Buffer.from(authority.entryBytes),
    });
  }
  const brand = controlledGraphBrand.get(authority.graph);
  if (!brand || authority.graph?.schemaVersion
    !== COLD_EXECUTION_AUTHORITY_SCHEMAS.controlledGraph) {
    throw new TypeError('controlled_graph_execution_authority_graph_untrusted');
  }
  const expectedEntryPath = controlledExecutionGraphEntryPath(authority.graph);
  if (!expectedEntryPath || !sameFilesystemPath(expectedEntryPath, authority.entryPath)) {
    throw new TypeError('controlled_graph_execution_authority_entry_mismatch');
  }
  return authority;
}

export async function prebindProcessExecution(command, args, {
  cwd = process.cwd(),
  environment = process.env,
  stdinBytes = null,
  executionAuthority = null,
} = {}) {
  const normalizedArgs = validateProcessArguments(command, args ?? []);
  const authority = validateExecutionAuthority(executionAuthority);
  if (!path.isAbsolute(command)) return null;
  let handle;
  try {
    const resolvedPath = await realpath(command);
    const commandMetadata = await lstat(resolvedPath);
    if (!commandMetadata.isFile() || commandMetadata.isSymbolicLink()) return null;
    handle = await open(resolvedPath, 'r');
    const beforeHandleMetadata = await handle.stat({ bigint: true });
    const beforePathMetadata = await lstat(resolvedPath, { bigint: true });
    if (
      !beforeHandleMetadata.isFile()
      || !beforePathMetadata.isFile()
      || beforePathMetadata.isSymbolicLink()
    ) {
      await handle.close();
      return null;
    }
    const executableBytes = await handle.readFile();
    const afterHandleMetadata = await handle.stat({ bigint: true });
    const afterPathMetadata = await lstat(resolvedPath, { bigint: true });
    const afterResolvedPath = await realpath(resolvedPath);
    const preboundFileIdentity = executableFileIdentity(afterHandleMetadata);
    const preboundPathIdentity = executableFileIdentity(afterPathMetadata);
    if (
      executableBytes.byteLength === 0
      || !afterHandleMetadata.isFile()
      || !afterPathMetadata.isFile()
      || afterPathMetadata.isSymbolicLink()
      || !sameFilesystemPath(resolvedPath, afterResolvedPath)
      || !sameRecordedExecutableFileIdentity(
        executableFileIdentity(beforeHandleMetadata),
        preboundFileIdentity,
      )
      || !sameRecordedExecutableFileIdentity(
        executableFileIdentity(beforePathMetadata),
        preboundPathIdentity,
      )
    ) {
      await handle.close();
      return null;
    }

    let entryBytes = null;
    let entryPathHash = null;
    let entryDelivery = null;
    let executionGraphHash = null;
    let invocationRegisteredOutputsHash = null;
    const requestedEnvironment = authority === null
      ? null
      : snapshotAuthorityEnvironment(environment);
    const executionEnvironment = requestedEnvironment === null
      ? null
      : sanitizedAuthorityEnvironment(requestedEnvironment);
    const stdinEntryInvocationClassification = authority?.kind === 'stdin_entry_bytes'
      ? classifyStdinEntryInvocation(normalizedArgs, requestedEnvironment)
      : null;
    const stdinEntryInvocationClassificationHash = stdinEntryInvocationClassification === null
      ? null
      : valueHash(stdinEntryInvocationClassification);
    if (authority?.kind === 'controlled_ecmascript_graph') {
      if (await verifyControlledExecutionGraph(authority.graph) !== true) {
        await handle.close();
        return null;
      }
      const graphBrand = controlledGraphBrand.get(authority.graph);
      if (!graphBrand || graphBrand.executionState.prebound === true) {
        await handle.close();
        return null;
      }
      const graphRoot = controlledExecutionGraphRoot(authority.graph);
      if (!sameFilesystemPath(cwd, graphRoot) || normalizedArgs[0] !== authority.entryPath) {
        await handle.close();
        return null;
      }
      const entryObservation = await readVerifiedRegularFile(authority.entryPath, {
        trustedRoot: graphRoot,
        allowEmpty: false,
        label: 'controlled_graph_execution_entry',
      });
      entryBytes = entryObservation.bytes;
      entryPathHash = valueHash(path.resolve(entryObservation.path));
      entryDelivery = 'controlled_ecmascript_graph';
      executionGraphHash = authority.graph.graphHash;
      invocationRegisteredOutputsHash = registeredOutputsHash(graphBrand);
      graphBrand.executionState.prebound = true;
      graphBrand.executionState.registeredOutputsHash = invocationRegisteredOutputsHash;
    } else if (authority?.kind === 'stdin_entry_bytes') {
      const deliveredBytes = stdinBytes === null ? null : Buffer.from(stdinBytes);
      if (!deliveredBytes || !authority.entryBytes.equals(deliveredBytes)) {
        await handle.close();
        return null;
      }
      entryBytes = Buffer.from(authority.entryBytes);
      entryDelivery = 'stdin_entry_bytes';
    }
    const deliveredBytes = stdinBytes === null ? null : Buffer.from(stdinBytes);
    const entryBytesHash = entryBytes === null ? null : byteHash(entryBytes);
    const entryByteLength = entryBytes?.byteLength ?? null;
    const stdinBytesHash = deliveredBytes === null ? null : byteHash(deliveredBytes);
    const stdinByteLength = deliveredBytes?.byteLength ?? null;
    const binding = Object.freeze({
      schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.executableBinding,
      resolvedPath,
      pathHash: valueHash(path.resolve(resolvedPath)),
      executableHash: byteHash(executableBytes),
      executableByteLength: executableBytes.byteLength,
      preboundFileIdentity,
      preboundPathIdentity,
      prelaunchFileIdentityStable: sameExecutableFileIdentity(
        preboundFileIdentity,
        preboundPathIdentity,
      ),
      device: preboundFileIdentity.deviceIdentity,
      inode: preboundFileIdentity.inodeIdentity,
      pathDevice: preboundPathIdentity.deviceIdentity,
      pathInode: preboundPathIdentity.inodeIdentity,
      entryDelivery,
      entryPathHash,
      entryBytesHash,
      entryByteLength,
      stdinBytesHash,
      stdinByteLength,
      requestedEnvironmentHash: requestedEnvironment?.hash ?? null,
      executionEnvironmentHash: executionEnvironment?.hash ?? null,
      stdinEntryInvocationClassification,
      stdinEntryInvocationClassificationHash,
      registeredOutputsHash: invocationRegisteredOutputsHash,
      invocationHash: valueHash({
        command: resolvedPath,
        args: normalizedArgs,
        cwd: path.resolve(cwd),
        entryDelivery,
        entryBytesHash,
        entryByteLength,
        stdinBytesHash,
        stdinByteLength,
        requestedEnvironmentHash: requestedEnvironment?.hash ?? null,
        executionEnvironmentHash: executionEnvironment?.hash ?? null,
        stdinEntryInvocationClassificationHash,
        executionGraphHash,
        registeredOutputsHash: invocationRegisteredOutputsHash,
      }),
      executionGraphHash,
    });
    return {
      binding,
      handle,
      executionEnvironment: executionEnvironment?.environment ?? null,
    };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

async function readObservedExecutablePath(openPath, loadedPath) {
  const handle = await open(openPath, 'r');
  try {
    const beforeHandleMetadata = await handle.stat({ bigint: true });
    const beforePathMetadata = await lstat(loadedPath, { bigint: true });
    if (
      !beforeHandleMetadata.isFile()
      || !beforePathMetadata.isFile()
      || beforePathMetadata.isSymbolicLink()
    ) return null;
    const loadedBytes = await handle.readFile();
    const afterHandleMetadata = await handle.stat({ bigint: true });
    const afterPathMetadata = await lstat(loadedPath, { bigint: true });
    const postResolvedPath = await realpath(loadedPath);
    const observedFileIdentity = executableFileIdentity(afterHandleMetadata);
    const observedPathIdentity = executableFileIdentity(afterPathMetadata);
    if (
      loadedBytes.byteLength === 0
      || !afterHandleMetadata.isFile()
      || !afterPathMetadata.isFile()
      || afterPathMetadata.isSymbolicLink()
      || !sameFilesystemPath(loadedPath, postResolvedPath)
      || !sameRecordedExecutableFileIdentity(
        executableFileIdentity(beforeHandleMetadata),
        observedFileIdentity,
      )
      || !sameRecordedExecutableFileIdentity(
        executableFileIdentity(beforePathMetadata),
        observedPathIdentity,
      )
    ) return null;
    return Object.freeze({
      contentHash: byteHash(loadedBytes),
      byteLength: loadedBytes.byteLength,
      pathHash: valueHash(path.resolve(loadedPath)),
      observedFileIdentity,
      observedPathIdentity,
      device: observedFileIdentity.deviceIdentity,
      inode: observedFileIdentity.inodeIdentity,
    });
  } finally {
    await handle.close();
  }
}

export async function observeSpawnedExecutable(child, prelaunchBinding) {
  if (
    prelaunchBinding?.schemaVersion !== COLD_EXECUTION_AUTHORITY_SCHEMAS.executableBinding
    || !child?.pid
  ) return null;
  try {
    if (process.platform === 'linux') {
      const procExecutablePath = `/proc/${child.pid}/exe`;
      const loadedPath = await realpath(procExecutablePath);
      const observed = await readObservedExecutablePath(procExecutablePath, loadedPath);
      if (!observed) return null;
      return Object.freeze({
        ...observed,
        observationKind: 'procfs_mapped_executable_handle',
        mappedImageIdentityAttested: true,
        preboundIdentityMatches: Boolean(
          sameExecutableFileIdentity(
            prelaunchBinding.preboundFileIdentity,
            observed.observedFileIdentity,
          )
          && sameExecutableFileIdentity(
            prelaunchBinding.preboundPathIdentity,
            observed.observedPathIdentity,
          )
        ),
      });
    }
    if (process.platform === 'win32') {
      const powershellPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      const imageQuery = spawnSync(powershellPath, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Process -Id ${child.pid} -ErrorAction Stop).Path`,
      ], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (imageQuery.status !== 0 || typeof imageQuery.stdout !== 'string') return null;
      const observedImagePath = imageQuery.stdout.trim();
      if (!path.isAbsolute(observedImagePath)) return null;
      const loadedPath = await realpath(observedImagePath);
      const observed = await readObservedExecutablePath(loadedPath, loadedPath);
      if (!observed) return null;
      return Object.freeze({
        ...observed,
        observationKind: 'windows_process_pathname_reopen_diagnostic_only',
        mappedImageIdentityAttested: false,
        preboundIdentityMatches: Boolean(
          sameExecutableFileIdentity(
            prelaunchBinding.preboundFileIdentity,
            observed.observedFileIdentity,
          )
          && sameExecutableFileIdentity(
            prelaunchBinding.preboundPathIdentity,
            observed.observedPathIdentity,
          )
        ),
        blockingGap: 'windows_mapped_image_native_attestation_missing',
      });
    }
    return null;
  } catch {
    return null;
  }
}

function killChildTree(child) {
  if (!child?.pid) return false;
  try {
    child.kill('SIGTERM');
  } catch {
    // Timeout cleanup has no execution authority.
  }
  if (process.platform === 'win32') {
    try {
      spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: 3000,
        windowsHide: true,
      });
    } catch {
      // child.kill above is the portable fallback.
    }
  }
  const hardKill = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process may already be gone.
    }
  }, 2000);
  hardKill.unref?.();
  return true;
}

function releaseChildHandles(child) {
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    try {
      stream?.destroy?.();
    } catch {
      // Best-effort timeout cleanup only.
    }
  }
  try {
    child?.unref?.();
  } catch {
    // Best-effort timeout cleanup only.
  }
}

function boundedCaptureLimit(value, fallback) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return fallback;
  return Math.min(number, COLD_EXECUTION_AUTHORITY_LIMITS.capturedStreamBytes);
}

function hasPipedStdin(stdio) {
  if (stdio === undefined || stdio === 'pipe') return true;
  if (!Array.isArray(stdio) || utilTypes.isProxy(stdio)) return false;
  const descriptor = Reflect.getOwnPropertyDescriptor(stdio, '0');
  return Boolean(
    descriptor
    && Object.hasOwn(descriptor, 'value')
    && descriptor.value === 'pipe'
  );
}

function appendCapturedBytes(current, chunk, maximumBytes) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return Object.freeze({
    bytes: next.byteLength <= maximumBytes
      ? next
      : next.subarray(next.byteLength - maximumBytes),
    truncated: next.byteLength > maximumBytes,
  });
}

export async function runProcess(command, args, options = {}) {
  const {
    stdinBytes = null,
    executionAuthority = null,
    ...processOptions
  } = options ?? {};
  let normalizedArgs;
  let authority;
  let suppliedStdinBytes;
  try {
    normalizedArgs = validateProcessArguments(command, args ?? []);
    authority = validateExecutionAuthority(executionAuthority);
    suppliedStdinBytes = stdinBytes === null ? null : Buffer.from(stdinBytes);
  } catch (error) {
    if (executionAuthority === null || executionAuthority === undefined) throw error;
    return {
      exitCode: null,
      signal: null,
      error: 'prelaunch_authority_schema_invalid',
      authorityError: error?.message ?? String(error),
      stdout: '',
      stderr: '',
      timedOut: false,
      timeoutMs: Number(processOptions.timeoutMs) || 0,
      timeoutKillAttempted: false,
      childPid: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
  if (
    authority?.kind === 'stdin_entry_bytes'
    && !hasPipedStdin(processOptions.stdio)
  ) {
    return {
      exitCode: null,
      signal: null,
      error: 'prelaunch_authority_binding_failed',
      authorityError: 'stdin_entry_execution_authority_requires_piped_stdin',
      stdout: '',
      stderr: '',
      timedOut: false,
      timeoutMs: Number(processOptions.timeoutMs) || 0,
      timeoutKillAttempted: false,
      childPid: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
  const preboundExecution = await prebindProcessExecution(command, normalizedArgs, {
    cwd: processOptions.cwd,
    environment: processOptions.env ?? process.env,
    stdinBytes: suppliedStdinBytes,
    executionAuthority: authority,
  });
  const prelaunchBinding = preboundExecution?.binding ?? null;
  if (!preboundExecution && authority !== null) {
    return {
      exitCode: null,
      signal: null,
      error: 'prelaunch_authority_binding_failed',
      stdout: '',
      stderr: '',
      timedOut: false,
      timeoutMs: Number(processOptions.timeoutMs) || 0,
      timeoutKillAttempted: false,
      childPid: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
  return new Promise((resolve) => {
    const {
      timeoutMs = 0,
      stdoutMax = 32_000,
      stderrMax = 32_000,
      streamOutput = true,
      ...spawnOptionsInput
    } = processOptions;
    const stdoutLimit = boundedCaptureLimit(stdoutMax, 32_000);
    const stderrLimit = boundedCaptureLimit(stderrMax, 32_000);
    const spawnOptions = { ...spawnOptionsInput };
    if (authority !== null) {
      spawnOptions.env = preboundExecution.executionEnvironment;
    }
    if (authority?.kind === 'controlled_ecmascript_graph') {
      spawnOptions.cwd = controlledExecutionGraphRoot(authority.graph);
    }
    const startedAt = new Date().toISOString();
    const startedMonotonicNs = process.hrtime.bigint().toString();
    let child;
    try {
      child = spawn(command, normalizedArgs, spawnOptions);
      void preboundExecution?.handle.close().catch(() => {});
    } catch (error) {
      void preboundExecution?.handle.close().catch(() => {});
      resolve({
        exitCode: null,
        signal: null,
        error: error?.message || String(error),
        stdout: '',
        stderr: '',
        timedOut: false,
        timeoutMs: Number(timeoutMs) || 0,
        timeoutKillAttempted: false,
        childPid: null,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
      return;
    }
    const spawnedExecutableObservationPromise = observeSpawnedExecutable(child, prelaunchBinding);
    let stdinDeliveryConfirmed = suppliedStdinBytes === null;
    let stdinDeliveryFailed = false;
    let stdoutBytes = Buffer.alloc(0);
    let stderrBytes = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let timeoutKillAttempted = false;
    let settled = false;
    let timeoutFinalizeTimer = null;
    const timer = Number(timeoutMs) > 0
      ? setTimeout(() => {
        timedOut = true;
        timeoutKillAttempted = killChildTree(child);
        timeoutFinalizeTimer = setTimeout(() => {
          releaseChildHandles(child);
          void finish({
            exitCode: null,
            signal: 'timeout-forced-finalize',
            error: 'process_timeout_forced_finalize',
          });
        }, 5000);
        timeoutFinalizeTimer.unref?.();
      }, Number(timeoutMs))
      : null;
    timer?.unref?.();
    const finish = async (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timeoutFinalizeTimer) clearTimeout(timeoutFinalizeTimer);
      const stdout = stdoutBytes.toString('utf8');
      const stderr = stderrBytes.toString('utf8');
      const executionResult = {
        ...payload,
        stdout,
        stderr,
        stdoutTruncated,
        stdout_truncated: stdoutTruncated,
        stderrTruncated,
        stderr_truncated: stderrTruncated,
        timedOut,
        timeoutMs: Number(timeoutMs) || 0,
        timeoutKillAttempted,
        childPid: child.pid ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
        startedMonotonicNs,
        finishedMonotonicNs: process.hrtime.bigint().toString(),
      };
      const spawnedExecutableObservation = await spawnedExecutableObservationPromise;
      const executionGraphStable = authority?.kind === 'controlled_ecmascript_graph'
        ? await verifyControlledExecutionGraph(authority.graph, { requireOutputs: true })
        : null;
      const processChannelCaptured = Boolean(
        child.stdout
        && child.stderr
        && (
          authority?.kind !== 'stdin_entry_bytes'
          || (stdinDeliveryConfirmed === true && stdinDeliveryFailed === false)
        )
        && stdoutTruncated === false
        && stderrTruncated === false
        && timedOut === false
        && payload.error === null
      );
      const resultChannelHash = valueHash({
        exitCode: executionResult.exitCode,
        signal: executionResult.signal,
        error: executionResult.error,
        timedOut: executionResult.timedOut,
        stdoutHash: byteHash(stdoutBytes),
        stdoutByteLength: stdoutBytes.byteLength,
        stderrHash: byteHash(stderrBytes),
        stderrByteLength: stderrBytes.byteLength,
        startedAt: executionResult.startedAt,
        finishedAt: executionResult.finishedAt,
      });
      const spawnedExecutableIdentityStable = Boolean(
        prelaunchBinding?.prelaunchFileIdentityStable === true
        && spawnedExecutableObservation?.preboundIdentityMatches === true
        && sameExecutableFileIdentity(
          prelaunchBinding.preboundFileIdentity,
          spawnedExecutableObservation.observedFileIdentity,
        )
        && sameExecutableFileIdentity(
          prelaunchBinding.preboundPathIdentity,
          spawnedExecutableObservation.observedPathIdentity,
        )
      );
      const entryExecutionPathBytesStable = Boolean(
        prelaunchBinding
        && spawnedExecutableObservation?.contentHash === prelaunchBinding.executableHash
        && spawnedExecutableObservation?.pathHash === prelaunchBinding.pathHash
      );
      const executableIdentityStable = Boolean(
        entryExecutionPathBytesStable
        && spawnedExecutableIdentityStable
        && spawnedExecutableObservation?.mappedImageIdentityAttested === true
      );
      const loadedGraphIdentityAttested = authority?.kind === 'controlled_ecmascript_graph'
        ? false
        : null;
      const observation = Object.freeze({
        schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.processObservation,
        command: String(command),
        args: Object.freeze([...normalizedArgs]),
        childPid: executionResult.childPid,
        startedAt: executionResult.startedAt,
        finishedAt: executionResult.finishedAt,
        sessionNonce: `session:${randomBytes(32).toString('hex')}`,
        prelaunchBinding,
        spawnedExecutableHash: spawnedExecutableObservation?.contentHash ?? null,
        spawnedExecutableObservation,
        entryExecutionPathBytesStable,
        spawnedExecutableIdentityStable,
        executableIdentityStable,
        executionGraphHash: authority?.kind === 'controlled_ecmascript_graph'
          ? authority.graph.graphHash
          : null,
        executionGraphStable,
        loadedGraphIdentityAttested,
        loadedGraphIdentityGap: authority?.kind === 'controlled_ecmascript_graph'
          ? 'runtime_loaded_graph_identity_attestation_missing'
          : null,
        stdinDeliveryRequired: authority?.kind === 'stdin_entry_bytes',
        stdinDeliveryConfirmed,
        stdinDeliveryFailed,
        entryConsumptionAttested: authority?.kind === 'stdin_entry_bytes' ? false : null,
        entryConsumptionAttestationGap: authority?.kind === 'stdin_entry_bytes'
          ? ENTRY_CONSUMPTION_ATTESTATION_GAP
          : null,
        processChannelCaptured,
        stdoutBytesHash: byteHash(stdoutBytes),
        stdoutByteLength: stdoutBytes.byteLength,
        stderrBytesHash: byteHash(stderrBytes),
        stderrByteLength: stderrBytes.byteLength,
        parentMonotonicInterval: Object.freeze({
          clockDomain: 'parent_process_hrtime',
          startNs: executionResult.startedMonotonicNs,
          endNs: executionResult.finishedMonotonicNs,
        }),
        resultChannelHash,
      });
      processObservationBrand.set(executionResult, observation);
      processExecutionContextBrand.set(executionResult, Object.freeze({
        authorityKind: authority?.kind ?? null,
        graph: authority?.kind === 'controlled_ecmascript_graph' ? authority.graph : null,
        stdoutBytes: Buffer.from(stdoutBytes),
        stderrBytes: Buffer.from(stderrBytes),
      }));
      resolve(executionResult);
    };
    child.stdout?.on('data', (chunk) => {
      const appended = appendCapturedBytes(stdoutBytes, chunk, stdoutLimit);
      stdoutBytes = appended.bytes;
      stdoutTruncated = stdoutTruncated || appended.truncated;
      if (streamOutput) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      const appended = appendCapturedBytes(stderrBytes, chunk, stderrLimit);
      stderrBytes = appended.bytes;
      stderrTruncated = stderrTruncated || appended.truncated;
      if (streamOutput) process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      void finish({ exitCode: null, signal: null, error: error.message });
    });
    child.on('close', (exitCode, signal) => {
      void finish({ exitCode, signal, error: null });
    });
    if (suppliedStdinBytes !== null) {
      if (!child.stdin) {
        stdinDeliveryFailed = true;
      } else {
        child.stdin.once('error', () => {
          stdinDeliveryFailed = true;
        });
        child.stdin.end(suppliedStdinBytes, (error) => {
          if (error) stdinDeliveryFailed = true;
          stdinDeliveryConfirmed = stdinDeliveryFailed === false;
        });
      }
    }
  });
}

export function getProcessExecutionAuthority(executionResult) {
  return processObservationBrand.get(executionResult) ?? null;
}

export function hashObservedExecutionAuthority(
  executionResult,
  authorityReceipt = null,
) {
  const observation = processObservationBrand.get(executionResult);
  const context = processExecutionContextBrand.get(executionResult);
  const binding = observation?.prelaunchBinding;
  const entryConsumptionReceiptAccepted = binding?.entryDelivery === 'stdin_entry_bytes'
    ? verifyRuntimeEntryConsumptionReceipt(executionResult, authorityReceipt)
    : null;
  if (
    binding?.entryDelivery === 'stdin_entry_bytes'
    && (
      isCanonicalExclusiveStdinInvocationBinding(binding) !== true
      || entryConsumptionReceiptAccepted !== true
      || observation?.entryConsumptionAttested !== true
      || observation?.entryConsumptionAttestationGap !== null
    )
  ) return null;
  if (
    binding?.schemaVersion !== COLD_EXECUTION_AUTHORITY_SCHEMAS.executableBinding
    || !context
    || observation.executableIdentityStable !== true
    || observation.spawnedExecutableObservation?.mappedImageIdentityAttested !== true
    || observation.spawnedExecutableIdentityStable !== true
    || observation.processChannelCaptured !== true
    || !sameExecutableFileIdentity(
      binding.preboundFileIdentity,
      observation.spawnedExecutableObservation?.observedFileIdentity,
    )
    || !sameExecutableFileIdentity(
      binding.preboundPathIdentity,
      observation.spawnedExecutableObservation?.observedPathIdentity,
    )
    || !['stdin_entry_bytes', 'controlled_ecmascript_graph'].includes(binding.entryDelivery)
    || !CANONICAL_SHA256_PATTERN.test(binding.entryBytesHash ?? '')
    || !CANONICAL_SHA256_PATTERN.test(observation.resultChannelHash ?? '')
  ) return null;
  let resultBinding;
  if (binding.entryDelivery === 'stdin_entry_bytes') {
    if (
      context.authorityKind !== 'stdin_entry_bytes'
      || observation.stdinDeliveryRequired !== true
      || observation.stdinDeliveryConfirmed !== true
      || observation.stdinDeliveryFailed !== false
      || entryConsumptionReceiptAccepted !== true
      || observation.entryConsumptionAttested !== true
      || observation.entryConsumptionAttestationGap !== null
      || byteHash(context.stdoutBytes) !== observation.stdoutBytesHash
      || context.stdoutBytes.byteLength !== observation.stdoutByteLength
      || byteHash(context.stderrBytes) !== observation.stderrBytesHash
      || context.stderrBytes.byteLength !== observation.stderrByteLength
    ) return null;
    resultBinding = Object.freeze({
      kind: 'runtime_observed_entry_consumption_receipt',
      receiptHash: authorityReceipt.receiptHash,
      mappedExecutableIdentityHash: authorityReceipt.mappedExecutableIdentityHash,
      invocationHash: authorityReceipt.invocationHash,
      stdinBytesHash: authorityReceipt.stdinBytesHash,
      stdinByteLength: authorityReceipt.stdinByteLength,
      interpreterMode: authorityReceipt.interpreterMode,
      stdinInvocationClassificationHash:
        authorityReceipt.stdinInvocationClassificationHash,
      interpretedEntrySetHash: authorityReceipt.interpretedEntrySetHash,
      interpretedEntryCount: authorityReceipt.interpretedEntryCount,
      sideLoadedEntryCount: authorityReceipt.sideLoadedEntryCount,
      processResultChannelHash: authorityReceipt.processResultChannelHash,
      stdoutBytesHash: observation.stdoutBytesHash,
      stdoutByteLength: observation.stdoutByteLength,
      stderrBytesHash: observation.stderrBytesHash,
      stderrByteLength: observation.stderrByteLength,
    });
  } else {
    if (
      context.authorityKind !== 'controlled_ecmascript_graph'
      || !CANONICAL_SHA256_PATTERN.test(observation.executionGraphHash ?? '')
      || observation.executionGraphHash !== binding.executionGraphHash
      || observation.executionGraphStable !== true
      || observation.loadedGraphIdentityAttested !== true
      || verifyRegisteredGraphResultReceipt(
        executionResult,
        authorityReceipt,
      ) !== true
    ) return null;
    resultBinding = Object.freeze({
      kind: 'verified_registered_graph_result_receipt',
      receiptHash: authorityReceipt.receiptHash,
      resultBytesHash: authorityReceipt.resultBytesHash,
      resultByteLength: authorityReceipt.resultByteLength,
      resultRole: authorityReceipt.resultRole,
      resultPathHash: authorityReceipt.resultPathHash,
      registeredOutputsHash: authorityReceipt.registeredOutputsHash,
      processResultChannelHash: authorityReceipt.processResultChannelHash,
    });
  }
  return valueHash({
    schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.observedAuthority,
    executableBinding: binding,
    invocationHash: binding.invocationHash,
    entryBytesHash: binding.entryBytesHash,
    executionGraphHash: observation.executionGraphHash,
    spawnedExecutableHash: observation.spawnedExecutableHash,
    mappedImageIdentityAttested:
      observation.spawnedExecutableObservation?.mappedImageIdentityAttested === true,
    childPid: observation.childPid,
    startedAt: observation.startedAt,
    finishedAt: observation.finishedAt,
    sessionNonce: observation.sessionNonce,
    resultBinding,
  });
}
