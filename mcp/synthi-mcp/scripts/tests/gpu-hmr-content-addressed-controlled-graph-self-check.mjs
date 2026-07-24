import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeArtifactToCas } from '../lib/gpu-hmr-artifact-cas.mjs';
import { createContentAddressedControlledExecutionGraph } from '../lib/gpu-hmr-content-addressed-controlled-graph.mjs';
import {
  controlledExecutionGraphRoot,
  removeControlledExecutionGraph,
  verifyControlledExecutionGraph,
} from '../lib/gpu-hmr-cold-execution-authority.mjs';

const casRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-content-graph-cas-'));
const trustedRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-content-graph-root-'));
const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-content-graph-outside-'));
const graphs = [];

const expectReject = async (operation, pattern) => {
  await assert.rejects(operation, pattern);
};

const artifact = async (bytes, root = casRoot) => writeArtifactToCas(bytes, {
  artifactRoot: root,
  mediaType: 'application/octet-stream',
  producer: { name: 'content_addressed_controlled_graph_self_check', kind: 'self_check' },
  sessionNamespace: 'content-addressed-controlled-graph-self-check',
  role: 'support_only_input',
});

try {
  const entryBytes = Buffer.from("import { value } from './lib/value.mjs';\nconsole.log(value);\n");
  const moduleBytes = Buffer.from("export const value = 'content-addressed';\n");
  const supportBytes = Buffer.from('support bytes are not runtime authority\n');
  const [entryLocator, moduleLocator, supportLocator] = await Promise.all([
    artifact(entryBytes),
    artifact(moduleBytes),
    artifact(supportBytes),
  ]);
  const input = {
    trustedRoot,
    allowedRoots: [casRoot],
    entry: { relativePath: 'entry.mjs', locator: entryLocator },
    modules: [{ relativePath: 'lib/value.mjs', locator: moduleLocator }],
    supports: [{ relativePath: 'notes/support.bin', locator: supportLocator }],
  };

  const result = await createContentAddressedControlledExecutionGraph(input);
  graphs.push(result.graph);
  assert.equal(result.supportEvidenceOnly, true);
  assert.equal(result.acceptedForGpuHmr, false);
  assert.equal(result.gpuHmrSuccess, false);
  assert.equal(result.canSatisfyRuntimeProof, false);
  assert.equal(await verifyControlledExecutionGraph(result.graph), true);
  assert.equal(result.graphHash, result.graph.graphHash);
  assert.deepEqual(result.graph.entries.map((entry) => ({
    relativePath: entry.relativePath,
    role: entry.role,
    contentHash: entry.contentHash,
    byteLength: entry.byteLength,
  })), [
    {
      relativePath: 'entry.mjs',
      role: 'generated_ecmascript_entry',
      contentHash: entryLocator.contentHash,
      byteLength: entryBytes.byteLength,
    },
    {
      relativePath: 'lib/value.mjs',
      role: 'ecmascript_module_root',
      contentHash: moduleLocator.contentHash,
      byteLength: moduleBytes.byteLength,
    },
    {
      relativePath: 'notes/support.bin',
      role: 'support_input',
      contentHash: supportLocator.contentHash,
      byteLength: supportBytes.byteLength,
    },
  ]);
  assert.deepEqual(result.artifactBindings.map((binding) => ({
    graphInputRole: binding.graphInputRole,
    relativePath: binding.relativePath,
    contentHash: binding.contentHash,
    byteLength: binding.byteLength,
  })), [
    { graphInputRole: 'entry', relativePath: 'entry.mjs', contentHash: entryLocator.contentHash, byteLength: entryBytes.byteLength },
    { graphInputRole: 'module', relativePath: 'lib/value.mjs', contentHash: moduleLocator.contentHash, byteLength: moduleBytes.byteLength },
    { graphInputRole: 'support', relativePath: 'notes/support.bin', contentHash: supportLocator.contentHash, byteLength: supportBytes.byteLength },
  ]);

  const materialRoot = controlledExecutionGraphRoot(result.graph);
  const materializedBeforeMutation = await Promise.all([
    readFile(path.join(materialRoot, 'entry.mjs')),
    readFile(path.join(materialRoot, 'lib', 'value.mjs')),
    readFile(path.join(materialRoot, 'notes', 'support.bin')),
  ]);

  const forgedLocator = {
    ...entryLocator,
    contentHash: `sha256:${'f'.repeat(64)}`,
    manifestHash: null,
  };
  await expectReject(() => createContentAddressedControlledExecutionGraph({
    ...input,
    entry: { relativePath: 'forged.mjs', locator: forgedLocator },
  }), /content_addressed_controlled_graph_artifact_invalid|artifact_cas/);

  const outsideLocator = await artifact(Buffer.from('outside\n'), outsideRoot);
  await expectReject(() => createContentAddressedControlledExecutionGraph({
    ...input,
    entry: { relativePath: 'outside.mjs', locator: outsideLocator },
  }), /content_addressed_controlled_graph_artifact_invalid|artifact_cas/);

  const mutableLocator = await artifact(Buffer.from(
    "export const snapshotted = 'before-mutation';\n",
  ));
  const mutableLocatorGraphPromise =
    createContentAddressedControlledExecutionGraph({
      ...input,
      entry: { relativePath: 'snapshotted.mjs', locator: mutableLocator },
      modules: [],
      supports: [],
    });
  mutableLocator.contentHash = `sha256:${'e'.repeat(64)}`;
  mutableLocator.storage.localPath = path.join(outsideRoot, 'forged.mjs');
  const mutableLocatorGraph = await mutableLocatorGraphPromise;
  graphs.push(mutableLocatorGraph.graph);
  assert.equal(await verifyControlledExecutionGraph(
    mutableLocatorGraph.graph,
  ), true);

  const oversizedDeclaredLocator = {
    ...moduleLocator,
    byteLength: 300 * 1024 * 1024,
    manifestHash: null,
  };
  await expectReject(() => createContentAddressedControlledExecutionGraph({
    ...input,
    entry: {
      relativePath: 'oversized-entry.mjs',
      locator: oversizedDeclaredLocator,
    },
    modules: [{
      relativePath: 'oversized-module.mjs',
      locator: oversizedDeclaredLocator,
    }],
    supports: [],
  }), /content_addressed_controlled_graph_declared_bytes_unbounded/);

  const underdeclaredLocator = await artifact(Buffer.alloc(4096, 0x20));
  const forgedUnderdeclaredLocator = {
    ...underdeclaredLocator,
    byteLength: 1,
    manifestHash: null,
  };
  await expectReject(() => createContentAddressedControlledExecutionGraph({
    ...input,
    entry: {
      relativePath: 'underdeclared.mjs',
      locator: forgedUnderdeclaredLocator,
    },
    modules: [],
    supports: [],
  }), /content_addressed_controlled_graph_artifact_unreadable/);

  const physicalDependencyPath = path.join(trustedRoot, 'physical.mjs');
  await writeFile(physicalDependencyPath, "export const physical = 'not declared in CAS';\n");
  const physicalEntryLocator = await artifact(Buffer.from(
    "import { physical } from './physical.mjs';\nconsole.log(physical);\n",
  ));
  await expectReject(() => createContentAddressedControlledExecutionGraph({
    ...input,
    entry: { relativePath: 'physical-entry.mjs', locator: physicalEntryLocator },
    modules: [],
    supports: [],
  }), /content_addressed_controlled_graph_undeclared_dependency/);

  const undeclaredRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-content-graph-metadata-'));
  try {
    await writeFile(path.join(undeclaredRoot, 'package.json'), '{"type":"module"}\n');
    await expectReject(() => createContentAddressedControlledExecutionGraph({
      ...input,
      trustedRoot: undeclaredRoot,
    }), /content_addressed_controlled_graph_undeclared_dependency/);
  } finally {
    await rm(undeclaredRoot, { recursive: true, force: true });
  }

  await expectReject(() => createContentAddressedControlledExecutionGraph({
    ...input,
    modules: [{ relativePath: 'entry.mjs', locator: moduleLocator }],
  }), /controlled_graph_module_entry_path_collision/);
  await expectReject(() => createContentAddressedControlledExecutionGraph({
    ...input,
    supports: [{ relativePath: 'entry.mjs', locator: supportLocator }],
  }), /controlled_graph_support_entry_path_collision/);
  if (process.platform === 'win32') {
    const alternateStreamEntryLocator = await artifact(Buffer.from(
      "export const materialized = 'exact bytes';\n",
    ));
    await expectReject(() => createContentAddressedControlledExecutionGraph({
      ...input,
      entry: {
        relativePath: 'entry:payload.mjs',
        locator: alternateStreamEntryLocator,
      },
      modules: [],
      supports: [],
    }), /content_addressed_controlled_graph_materialized_graph_invalid/);
  }

  let getterCalls = 0;
  const accessorInput = {
    allowedRoots: [casRoot],
    entry: input.entry,
    modules: input.modules,
    supports: input.supports,
  };
  Object.defineProperty(accessorInput, 'trustedRoot', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return trustedRoot;
    },
  });
  await expectReject(() => createContentAddressedControlledExecutionGraph(accessorInput), /content_addressed_controlled_graph_input_field_invalid/);
  assert.equal(getterCalls, 0);

  const proxiedInput = new Proxy({ ...input }, {
    get() {
      getterCalls += 1;
      throw new Error('proxy getter must not run');
    },
  });
  await expectReject(() => createContentAddressedControlledExecutionGraph(proxiedInput), /content_addressed_controlled_graph_input_invalid/);
  assert.equal(getterCalls, 0);

  await Promise.all([
    writeFile(entryLocator.storage.localPath, 'mutated entry'),
    writeFile(moduleLocator.storage.localPath, 'mutated module'),
    writeFile(supportLocator.storage.localPath, 'mutated support'),
  ]);
  assert.deepEqual(await Promise.all([
    readFile(path.join(materialRoot, 'entry.mjs')),
    readFile(path.join(materialRoot, 'lib', 'value.mjs')),
    readFile(path.join(materialRoot, 'notes', 'support.bin')),
  ]), materializedBeforeMutation);
  assert.equal(await verifyControlledExecutionGraph(result.graph), true);
} finally {
  for (const graph of graphs) await removeControlledExecutionGraph(graph);
  await Promise.all([
    rm(casRoot, { recursive: true, force: true }),
    rm(trustedRoot, { recursive: true, force: true }),
    rm(outsideRoot, { recursive: true, force: true }),
  ]);
}

console.log('gpu-hmr content-addressed controlled graph self-check passed');
