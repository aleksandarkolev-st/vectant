import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  COLD_EXECUTION_AUTHORITY_LIMITS,
  COLD_EXECUTION_AUTHORITY_SCHEMAS,
  controlledExecutionGraphEntryPath,
  controlledExecutionGraphMaterialPath,
  controlledExecutionGraphRoot,
  createControlledExecutionGraph,
  getProcessExecutionAuthority,
  hashObservedExecutionAuthority,
  loadControlledExecutionPackage,
  observeSpawnedExecutable,
  prebindProcessExecution,
  readRegisteredGraphResultReceipt,
  readVerifiedRegularFile,
  registerControlledExecutionOutput,
  removeControlledExecutionGraph,
  runProcess,
  verifyControlledExecutionGraph,
  verifyPreviouslyReadRegularFile,
  verifyRegisteredGraphResultReceipt,
  verifyRuntimeEntryConsumptionReceipt,
} from '../lib/gpu-hmr-cold-execution-authority.mjs';

function byteHash(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalHash(value) {
  const canonicalize = (entry) => {
    if (Array.isArray(entry)) return entry.map(canonicalize);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.keys(entry).sort().map(
        (key) => [key, canonicalize(entry[key])],
      ));
    }
    return entry;
  };
  return byteHash(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejected(operation, expectedPattern) {
  try {
    await operation();
    return false;
  } catch (error) {
    return expectedPattern.test(error?.message ?? String(error));
  }
}

async function selfCheck() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'synthi-cold-authority-check-'));
  const graphs = new Set();
  try {
    const localModulePath = path.join(temporaryRoot, 'lib', 'local.mjs');
    const supportPath = path.join(temporaryRoot, 'support', 'input.json');
    const packageRoot = path.join(
      temporaryRoot,
      'node_modules',
      'authority-test-package',
    );
    const packageEntryPath = path.join(packageRoot, 'index.mjs');
    const packageManifestPath = path.join(packageRoot, 'package.json');
    const packageHookScriptPath = path.join(packageRoot, 'hook.cjs');
    const packageTopLevelMarkerPath = path.join(
      temporaryRoot,
      'package-top-level-ran.txt',
    );
    const packageHookMarkerPath = path.join(temporaryRoot, 'package-hook-ran.txt');
    await mkdir(path.dirname(localModulePath), { recursive: true });
    await mkdir(path.dirname(supportPath), { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(temporaryRoot, 'package.json'), `${JSON.stringify({
      type: 'module',
    })}\n`);
    await writeFile(localModulePath, 'export default "local-exact-bytes";\n');
    await writeFile(supportPath, `${JSON.stringify({ support: 'observed-support-bytes' })}\n`);
    await writeFile(packageManifestPath, `${JSON.stringify({
      name: 'authority-test-package',
      version: '1.0.0',
      type: 'module',
      exports: './index.mjs',
      scripts: {
        preinstall: 'node hook.cjs',
      },
    })}\n`);
    await writeFile(packageHookScriptPath, [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(packageHookMarkerPath)}, 'hook-ran', { flag: 'wx' });`,
      '',
    ].join('\n'));
    await writeFile(packageEntryPath, [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(packageTopLevelMarkerPath)}, String(process.pid), { flag: 'wx' });`,
      'export default "package-exact-bytes";',
      '',
    ].join('\n'));

    const entryBytes = Buffer.from([
      "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
      "import localValue from './lib/local.mjs';",
      "import packageValue from 'authority-test-package';",
      "const support = JSON.parse(await readFile('./support/input.json', 'utf8'));",
      "const virtualSupport = await readFile('./support/virtual.bin', 'utf8');",
      "await mkdir('./result', { recursive: true });",
      "await writeFile('./result/output.json', JSON.stringify({",
      '  localValue, packageValue, support: support.support, virtualSupport,',
      "  injectedShim: globalThis.__coldAuthorityInjectedShim === true,",
      "}) + '\\n', { flag: 'wx' });",
      'await new Promise((resolve) => setTimeout(resolve, 900));',
      '',
    ].join('\n'), 'utf8');

    const createGraph = async (
      virtualSupportBytes = Buffer.from('immutable-virtual-support', 'utf8'),
    ) => {
      const graph = await createControlledExecutionGraph({
        trustedRoot: temporaryRoot,
        entryRelativePath: 'entry.mjs',
        entryBytes,
        moduleEntryPaths: [],
        supportFilePaths: [supportPath],
        supportEntries: [{
          relativePath: 'support/virtual.bin',
          bytes: virtualSupportBytes,
        }],
      });
      graphs.add(graph);
      return graph;
    };
    const removeGraph = async (graph) => {
      graphs.delete(graph);
      await removeControlledExecutionGraph(graph);
    };

    const callerOwnedVirtualSupport = Buffer.from(
      'immutable-virtual-support',
      'utf8',
    );
    const graph = await createGraph(callerOwnedVirtualSupport);
    callerOwnedVirtualSupport.fill(0);
    const entryPath = controlledExecutionGraphEntryPath(graph);
    const graphRoot = controlledExecutionGraphRoot(graph);
    assert(graph.graphKind === 'static_ecmascript_support_graph'
      && graph.graphCompletenessClaim === 'static_resolution_support_only'
      && graph.supportEvidenceOnly === true
      && graph.loadedGraphIdentityAttested === false,
    'static graph manifest claimed complete runtime-loaded identity');
    let packageSelectorCoerced = false;
    const packageSelector = {
      toString() {
        packageSelectorCoerced = true;
        return 'authority-test-package';
      },
    };
    assert(loadControlledExecutionPackage(graph, 'authority-test-package') === null
      && loadControlledExecutionPackage(graph, packageSelector) === null
      && packageSelectorCoerced === false,
    'controlled package loader retained an in-process execution path');
    assert(await readFile(packageTopLevelMarkerPath).then(
      () => false,
      (error) => error?.code === 'ENOENT',
    ) && await readFile(packageHookMarkerPath).then(
      () => false,
      (error) => error?.code === 'ENOENT',
    ), 'graph byte inspection executed package top-level code or lifecycle hooks');
    const outputSourcePath = path.join(temporaryRoot, 'result', 'output.json');
    const materialOutputPath = registerControlledExecutionOutput(graph, outputSourcePath);
    await mkdir(path.dirname(materialOutputPath), { recursive: true });
    assert(await verifyControlledExecutionGraph(graph) === true,
      'controlled graph changed before process prebinding');
    const injectedShimPath = path.join(temporaryRoot, 'injected-shim.cjs');
    await writeFile(injectedShimPath, 'globalThis.__coldAuthorityInjectedShim = true;\n');
    const safeAuthorityEnvironment = Object.freeze(Object.fromEntries([
      'HOME',
      'SystemRoot',
      'TEMP',
      'TMP',
      'TMPDIR',
      'USERPROFILE',
      'WINDIR',
    ].flatMap((name) => typeof process.env[name] === 'string'
      ? [[name, process.env[name]]]
      : [])));
    const execution = await runProcess(process.execPath, [entryPath], {
      cwd: graphRoot,
      env: {
        ...process.env,
        NODE_PATH: temporaryRoot,
        NODE_OPTIONS: `--require=${injectedShimPath}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      executionAuthority: {
        kind: 'controlled_ecmascript_graph',
        graph,
        entryPath,
      },
      timeoutMs: 10_000,
      streamOutput: false,
    });
    assert(
      execution.error === null && execution.exitCode === 0,
      `controlled exact graph failed before result capture: ${
        execution.error ?? execution.stderr
      }`,
    );
    const outputObservation = await readVerifiedRegularFile(materialOutputPath, {
      trustedRoot: graphRoot,
      allowEmpty: false,
      label: 'standalone_controlled_output',
    });
    const output = JSON.parse(outputObservation.bytes.toString('utf8'));
    const executionObservation = getProcessExecutionAuthority(execution);
    const resultReceipt = await readRegisteredGraphResultReceipt({
      executionResult: execution,
      graph,
      resultPath: materialOutputPath,
    });
    assert(output.localValue === 'local-exact-bytes', 'local module bytes were not executed');
    assert(output.packageValue === 'package-exact-bytes', 'package bytes were not executed');
    assert(output.support === 'observed-support-bytes', 'support bytes were not materialized');
    assert(output.virtualSupport === 'immutable-virtual-support',
      'caller mutation changed captured in-memory support bytes');
    assert(output.injectedShim === false, 'NODE_OPTIONS or NODE_PATH injected an unbound shim');
    assert((await readFile(packageTopLevelMarkerPath, 'utf8')).trim()
      === String(execution.childPid),
    'package top-level marker was not confined to the spawned graph process');
    assert(await readFile(packageHookMarkerPath).then(
      () => false,
      (error) => error?.code === 'ENOENT',
    ), 'package lifecycle hook executed during graph inspection or execution');
    assert(
      executionObservation?.schemaVersion
        === COLD_EXECUTION_AUTHORITY_SCHEMAS.processObservation,
      'process observation schema was not exact',
    );
    assert(executionObservation.executionGraphStable === true, 'executed graph was not stable');
    assert(executionObservation.loadedGraphIdentityAttested === false,
      'static graph claimed runtime loaded-graph identity');
    assert(executionObservation.loadedGraphIdentityGap
      === 'runtime_loaded_graph_identity_attestation_missing',
    'static graph omitted its runtime loader attestation gap');
    assert(resultReceipt?.schemaVersion
      === COLD_EXECUTION_AUTHORITY_SCHEMAS.verifiedResultReceipt,
    'registered graph output did not produce a verified result receipt');
    assert(resultReceipt.resultBytesHash === outputObservation.hash
      && resultReceipt.resultByteLength === outputObservation.byteLength
      && resultReceipt.bytes.equals(outputObservation.bytes),
    'verified result receipt did not bind exact output bytes');
    assert(resultReceipt.invocationHash
      === executionObservation.prelaunchBinding.invocationHash
      && resultReceipt.resultRole === 'registered_graph_process_result'
      && resultReceipt.processResultChannelHash
        === executionObservation.resultChannelHash,
    'verified result receipt omitted invocation, path role, or process-channel binding');
    assert(verifyRegisteredGraphResultReceipt(execution, resultReceipt) === true,
      'verified result receipt brand was not accepted for its process');
    assert(hashObservedExecutionAuthority(execution, outputObservation.hash) === null,
      'caller-supplied canonical result hash minted authority');
    assert(hashObservedExecutionAuthority(execution, resultReceipt) === null,
      'static graph receipt bypassed missing loaded-graph identity');
    assert(verifyRegisteredGraphResultReceipt(
      execution,
      structuredClone(resultReceipt),
    ) === false, 'serialized result receipt retained its private brand');
    assert(await readRegisteredGraphResultReceipt({
      executionResult: execution,
      graph,
      resultPath: entryPath,
    }) === null, 'unregistered graph path produced a result receipt');
    assert(await expectRejected(
      () => registerControlledExecutionOutput(
        graph,
        path.join(temporaryRoot, 'result', 'late-output.json'),
      ),
      /controlled_graph_output_registration_closed/,
    ), 'graph accepted a result registration after invocation prebinding');
    let receiptPathAccessorRead = false;
    const accessorReceiptInput = { executionResult: execution, graph };
    Object.defineProperty(accessorReceiptInput, 'resultPath', {
      enumerable: true,
      get() {
        receiptPathAccessorRead = true;
        return materialOutputPath;
      },
    });
    assert(await expectRejected(
      () => readRegisteredGraphResultReceipt(accessorReceiptInput),
      /non_data_field_refused/,
    ), 'result receipt input accessor was accepted');
    assert(receiptPathAccessorRead === false,
      'result receipt input accessor ran before exact record rejection');
    assert(await verifyPreviouslyReadRegularFile(outputObservation) === true,
      'observed output changed after verified read');
    assert(await verifyControlledExecutionGraph(graph, { requireOutputs: true }) === true,
      'controlled graph failed post-execution verification');
    resultReceipt.bytes[0] ^= 0xff;
    assert(verifyRegisteredGraphResultReceipt(execution, resultReceipt) === false,
      'mutated public receipt bytes retained receipt validity');
    await removeGraph(graph);

    const changedDependencyGraph = await createGraph();
    const changedDependencyPath = controlledExecutionGraphMaterialPath(
      changedDependencyGraph,
      localModulePath,
    );
    const changedDependencyEntry = controlledExecutionGraphEntryPath(changedDependencyGraph);
    await chmod(changedDependencyPath, 0o600).catch(() => {});
    await writeFile(changedDependencyPath, 'export default "changed-after-capture";\n');
    const changedDependencyExecution = await runProcess(
      process.execPath,
      [changedDependencyEntry],
      {
        cwd: controlledExecutionGraphRoot(changedDependencyGraph),
        stdio: ['ignore', 'pipe', 'pipe'],
        executionAuthority: {
          kind: 'controlled_ecmascript_graph',
          graph: changedDependencyGraph,
          entryPath: changedDependencyEntry,
        },
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    assert(changedDependencyExecution.error === 'prelaunch_authority_binding_failed'
      && changedDependencyExecution.childPid === null,
    'changed dependency was not refused before launch');
    await removeGraph(changedDependencyGraph);

    const untrackedFileGraph = await createGraph();
    await writeFile(
      path.join(controlledExecutionGraphRoot(untrackedFileGraph), 'untracked-shim.mjs'),
      'throw new Error("must not execute");\n',
    );
    assert(await verifyControlledExecutionGraph(untrackedFileGraph) === false,
      'newly created untracked file was accepted');
    await removeGraph(untrackedFileGraph);

    const untrackedDirectoryGraph = await createGraph();
    await mkdir(path.join(
      controlledExecutionGraphRoot(untrackedDirectoryGraph),
      'untracked-empty-directory',
    ));
    assert(await verifyControlledExecutionGraph(untrackedDirectoryGraph) === false,
      'newly created untracked directory was accepted');
    await removeGraph(untrackedDirectoryGraph);

    const dynamicImportRejected = await expectRejected(
      () => createControlledExecutionGraph({
        trustedRoot: temporaryRoot,
        entryRelativePath: 'dynamic-entry.mjs',
        entryBytes: Buffer.from("const next = './lib/local.mjs'; await import(next);\n"),
        moduleEntryPaths: [],
        supportFilePaths: [],
      }),
      /controlled_graph_untracked_dynamic_import/,
    );
    assert(dynamicImportRejected, 'non-literal dynamic import was accepted');

    assert(await expectRejected(
      () => createControlledExecutionGraph({
        trustedRoot: temporaryRoot,
        entryRelativePath: 'virtual-path-entry.mjs',
        entryBytes: Buffer.from('export default true;\n'),
        moduleEntryPaths: [],
        supportFilePaths: [],
        supportEntries: [{
          relativePath: '../escaped-input.bin',
          bytes: Buffer.from('must-not-escape'),
        }],
      }),
      /controlled_graph_support_entry_relative_path_must_be_canonical_relative_path/,
    ), 'in-memory support bytes escaped the controlled graph namespace');
    assert(await expectRejected(
      () => createControlledExecutionGraph({
        trustedRoot: temporaryRoot,
        entryRelativePath: 'virtual-collision-entry.mjs',
        entryBytes: Buffer.from('export default true;\n'),
        moduleEntryPaths: [],
        supportFilePaths: [],
        supportEntries: [{
          relativePath: 'virtual-collision-entry.mjs',
          bytes: Buffer.from('export default true;\n'),
        }],
      }),
      /controlled_graph_support_entry_path_collision/,
    ), 'in-memory support bytes replaced an executable graph entry');

    const staticGraphEscapeCases = [
      ['module_create_require', "import { createRequire } from 'node:module';\n"],
      ['module_global', 'module.require("node:fs");\n'],
      ['vm', "import vm from 'node:vm';\n"],
      ['worker_threads', "import { Worker } from 'node:worker_threads';\n"],
      ['child_process', "import { spawn } from 'node:child_process';\n"],
      ['process_get_builtin', "process.getBuiltinModule('fs');\n"],
      ['process_binding', "process.binding('fs');\n"],
      ['process_main_module', 'void process.mainModule;\n'],
      ['process_alias', 'const escapedProcess = process; void escapedProcess;\n'],
      ['eval', 'eval("globalThis.escape = true");\n'],
      ['bracket_eval', 'globalThis["eval"]("globalThis.escape = true");\n'],
      ['computed_eval', 'globalThis["ev" + "al"]("globalThis.escape = true");\n'],
      ['computed_process_loader', "process['get' + 'BuiltinModule']('fs');\n"],
      ['aliased_node_process', "import escapedProcess from 'node:process'; escapedProcess.getBuiltinModule('node:module');\n"],
      ['inspector_evaluate', "import inspector from 'node:inspector'; void inspector.Session;\n"],
      ['aliased_global', 'const escapedGlobal = globalThis; void escapedGlobal;\n'],
      ['reflective_eval', 'Reflect.get(globalThis, "eval")("globalThis.escape = true");\n'],
      ['function_constructor', 'Function("return 1")();\n'],
      ['indirect_constructor', 'const make = (() => {}).constructor; void make;\n'],
      ['destructured_constructor', 'const { constructor: Make } = (() => {}); Make("return 1")();\n'],
      ['computed_constructor', 'const make = (() => {})["con" + "structor"]; void make;\n'],
      ['descriptor_constructor', 'Object.getOwnPropertyDescriptor(Object.getPrototypeOf(async function () {}), "constructor").value("return 1");\n'],
      ['import_meta_resolve', "import.meta.resolve('node:fs');\n"],
    ];
    for (const [name, source] of staticGraphEscapeCases) {
      const rejected = await expectRejected(
        () => createControlledExecutionGraph({
          trustedRoot: temporaryRoot,
          entryRelativePath: `escape-${name}.mjs`,
          entryBytes: Buffer.from(source),
          moduleEntryPaths: [],
          supportFilePaths: [],
        }),
        /controlled_graph_alternate_loader_refused/,
      );
      assert(rejected, `static graph accepted alternate loader or code escape: ${name}`);
    }
    assert(await expectRejected(
      () => createControlledExecutionGraph({
        trustedRoot: temporaryRoot,
        entryRelativePath: 'escape-commonjs.cjs',
        entryBytes: Buffer.from('exports.value = 1;\n'),
        moduleEntryPaths: [],
        supportFilePaths: [],
      }),
      /controlled_graph_alternate_loader_refused/,
    ), 'static graph accepted a CommonJS loader entry');

    const namedGraphSelectorRejected = await expectRejected(
      () => createControlledExecutionGraph({
        trustedRoot: temporaryRoot,
        entryRelativePath: 'named-selector-entry.mjs',
        entryBytes: Buffer.from('process.stdout.write("must-not-run")\n'),
        moduleEntryPaths: [],
        supportFilePaths: [],
        backend: 'must-not-be-an-authority-input',
      }),
      /controlled_graph_input_fields_(?:invalid|unbounded)/,
    );
    assert(namedGraphSelectorRejected,
      'name-based graph selector was not rejected by the exact schema');

    const oversizedGraphRootsRejected = await expectRejected(
      () => createControlledExecutionGraph({
        trustedRoot: temporaryRoot,
        entryRelativePath: 'oversized-roots-entry.mjs',
        entryBytes: Buffer.from('process.stdout.write("must-not-run")\n'),
        moduleEntryPaths: Array(
          COLD_EXECUTION_AUTHORITY_LIMITS.graphRoots + 1,
        ).fill(localModulePath),
        supportFilePaths: [],
      }),
      /controlled_graph_module_entries_invalid_or_unbounded/,
    );
    assert(oversizedGraphRootsRejected, 'oversized graph root schema was accepted');

    const forbiddenAuthorityInput = await runProcess(
      process.execPath,
      ['--input-type=module', '-'],
      {
        cwd: temporaryRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        stdinBytes: Buffer.from('process.stdout.write("forbidden")\n'),
        executionAuthority: {
          kind: 'stdin_entry_bytes',
          entryBytes: Buffer.from('process.stdout.write("forbidden")\n'),
          projectName: 'must-not-be-an-authority-input',
        },
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    assert(forbiddenAuthorityInput.error === 'prelaunch_authority_schema_invalid'
      && forbiddenAuthorityInput.childPid === null,
    'name-based or unknown authority input was not rejected by the exact schema');

    const exactAuthorityBytes = Buffer.from('process.stdout.write("exact")\n');
    const runInvalidAuthority = (executionAuthority) => runProcess(
      process.execPath,
      ['--input-type=module', '-'],
      {
        cwd: temporaryRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        stdinBytes: exactAuthorityBytes,
        executionAuthority,
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    let authorityAccessorRead = false;
    const accessorAuthority = { kind: 'stdin_entry_bytes' };
    Object.defineProperty(accessorAuthority, 'entryBytes', {
      enumerable: true,
      get() {
        authorityAccessorRead = true;
        return exactAuthorityBytes;
      },
    });
    const accessorAuthorityResult = await runInvalidAuthority(accessorAuthority);
    assert(accessorAuthorityResult.error === 'prelaunch_authority_schema_invalid'
      && accessorAuthorityResult.childPid === null,
    'authority accessor field was accepted');
    assert(authorityAccessorRead === false,
      'authority accessor ran before exact record rejection');

    const symbolAuthority = {
      kind: 'stdin_entry_bytes',
      entryBytes: exactAuthorityBytes,
      [Symbol('forbidden')]: true,
    };
    const symbolAuthorityResult = await runInvalidAuthority(symbolAuthority);
    assert(symbolAuthorityResult.error === 'prelaunch_authority_schema_invalid'
      && symbolAuthorityResult.childPid === null,
    'authority symbol field was accepted');

    const unboundedAuthority = Object.fromEntries(Array.from(
      { length: COLD_EXECUTION_AUTHORITY_LIMITS.recordKeys + 1 },
      (_, index) => [`field${index}`, index],
    ));
    const unboundedAuthorityResult = await runInvalidAuthority(unboundedAuthority);
    assert(unboundedAuthorityResult.error === 'prelaunch_authority_schema_invalid'
      && /fields_unbounded/.test(unboundedAuthorityResult.authorityError ?? '')
      && unboundedAuthorityResult.childPid === null,
    'authority record key bound was not enforced before launch');

    const nonEnumerableAuthority = {
      kind: 'stdin_entry_bytes',
      entryBytes: exactAuthorityBytes,
    };
    Object.defineProperty(nonEnumerableAuthority, 'hidden', {
      enumerable: false,
      value: true,
    });
    const nonEnumerableAuthorityResult = await runInvalidAuthority(
      nonEnumerableAuthority,
    );
    assert(nonEnumerableAuthorityResult.error === 'prelaunch_authority_schema_invalid'
      && nonEnumerableAuthorityResult.childPid === null,
    'authority non-enumerable field was accepted');

    let graphInputAccessorRead = false;
    const accessorGraphInput = {
      trustedRoot: temporaryRoot,
      entryRelativePath: 'accessor-entry.mjs',
      moduleEntryPaths: [],
      supportFilePaths: [],
    };
    Object.defineProperty(accessorGraphInput, 'entryBytes', {
      enumerable: true,
      get() {
        graphInputAccessorRead = true;
        return Buffer.from('process.stdout.write("must-not-run")\n');
      },
    });
    assert(await expectRejected(
      () => createControlledExecutionGraph(accessorGraphInput),
      /non_data_field_refused/,
    ), 'graph input accessor field was accepted');
    assert(graphInputAccessorRead === false,
      'graph input accessor ran before exact record rejection');

    const wrapperOnlyExecution = await runProcess(
      process.execPath,
      ['-e', 'process.stdout.write("wrapper-only")'],
      {
        cwd: temporaryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    assert(wrapperOnlyExecution.exitCode === 0, 'wrapper-only control execution failed');
    assert(hashObservedExecutionAuthority(
      wrapperOnlyExecution,
      byteHash(Buffer.from(wrapperOnlyExecution.stdout, 'utf8')),
    ) === null, 'wrapper-only execution minted authority');

    const originalStdinBytes = Buffer.from('process.stdout.write("original")\n');
    const replacementStdinBytes = Buffer.from('process.stdout.write("replacement")\n');
    const mismatchedStdinExecution = await runProcess(
      process.execPath,
      ['--input-type=module', '-'],
      {
        cwd: temporaryRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        stdinBytes: replacementStdinBytes,
        executionAuthority: {
          kind: 'stdin_entry_bytes',
          entryBytes: originalStdinBytes,
        },
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    assert(mismatchedStdinExecution.error === 'prelaunch_authority_binding_failed'
      && mismatchedStdinExecution.childPid === null,
    'stdin byte replacement was not refused before launch');

    const ignoredStdinBytes = Buffer.from('process.stdout.write("must-not-run")\n');
    const ignoredStdinExecution = await runProcess(
      process.execPath,
      ['--input-type=module', '-'],
      {
        cwd: temporaryRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        stdinBytes: ignoredStdinBytes,
        executionAuthority: {
          kind: 'stdin_entry_bytes',
          entryBytes: ignoredStdinBytes,
        },
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    assert(ignoredStdinExecution.error === 'prelaunch_authority_binding_failed'
      && ignoredStdinExecution.authorityError
        === 'stdin_entry_execution_authority_requires_piped_stdin'
      && ignoredStdinExecution.childPid === null
      && hashObservedExecutionAuthority(ignoredStdinExecution) === null,
    'ignored stdin execution minted authority');

    const exactStdinBytes = Buffer.from([
      'process.stdout.write(JSON.stringify({',
      '  channel: "captured-stdin-channel",',
      '  injectedShim: globalThis.__coldAuthorityInjectedShim === true,',
      '}));',
      'await new Promise((resolve) => setTimeout(resolve, 1200));',
      '',
    ].join('\n'));
    const exactStdinExecution = await runProcess(
      process.execPath,
      ['--input-type=module', '-'],
      {
        cwd: temporaryRoot,
        env: safeAuthorityEnvironment,
        stdio: ['pipe', 'pipe', 'pipe'],
        stdinBytes: exactStdinBytes,
        executionAuthority: {
          kind: 'stdin_entry_bytes',
          entryBytes: exactStdinBytes,
        },
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    const exactStdinObservation = getProcessExecutionAuthority(exactStdinExecution);
    const exactStdinAuthorityHash = hashObservedExecutionAuthority(exactStdinExecution);
    assert(exactStdinExecution.exitCode === 0
      && exactStdinObservation?.stdinDeliveryRequired === true
      && exactStdinObservation?.stdinDeliveryConfirmed === true
      && exactStdinObservation?.stdinDeliveryFailed === false
      && exactStdinObservation?.entryConsumptionAttested === false
      && exactStdinObservation?.entryConsumptionAttestationGap
        === 'entry_consumption_attestation_missing'
      && exactStdinObservation?.prelaunchBinding
        .stdinEntryInvocationClassification?.schemaVersion
          === COLD_EXECUTION_AUTHORITY_SCHEMAS.stdinEntryInvocationClassification
      && exactStdinObservation.prelaunchBinding.stdinEntryInvocationClassification
        .canonicalInterpreterMode
          === 'runtime_observed_exclusive_stdin_entry_bytes'
      && exactStdinObservation.prelaunchBinding.stdinEntryInvocationClassification
        .exclusiveStdinEntryCandidate === true
      && exactStdinObservation.prelaunchBinding.requestedEnvironmentHash
        === exactStdinObservation.prelaunchBinding.executionEnvironmentHash
      && exactStdinObservation?.processChannelCaptured === true,
    'exact stdin support diagnostics omitted the entry-consumption gap');
    assert(JSON.parse(exactStdinExecution.stdout).injectedShim === false,
      'stdin authority execution loaded an unbound NODE_OPTIONS shim');
    assert(hashObservedExecutionAuthority(
      exactStdinExecution,
      byteHash(Buffer.from(exactStdinExecution.stdout, 'utf8')),
    ) === null, 'caller-supplied stdin result hash minted authority');
    assert(exactStdinAuthorityHash === null,
      'successful stdin pipe delivery minted authority without runtime consumption proof');
    if (process.platform === 'linux') {
      assert(exactStdinObservation.executableIdentityStable === true
        && exactStdinObservation.spawnedExecutableIdentityStable === true
        && exactStdinObservation.spawnedExecutableObservation
          ?.mappedImageIdentityAttested === true,
      'Linux mapped executable identity did not close');
    }
    if (process.platform === 'win32') {
      assert(exactStdinObservation.executableIdentityStable === false
        && exactStdinObservation.spawnedExecutableObservation
          ?.mappedImageIdentityAttested === false
        && exactStdinObservation.spawnedExecutableObservation?.blockingGap
          === 'windows_mapped_image_native_attestation_missing',
      'Windows pathname observation was treated as mapped-image identity');
    }

    const simulatedRuntimeReceiptSeed = {
      schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.runtimeEntryConsumptionReceipt,
      mappedExecutableIdentityHash: byteHash(Buffer.from('simulated-mapped-identity')),
      invocationHash: exactStdinObservation.prelaunchBinding.invocationHash,
      stdinBytesHash: exactStdinObservation.prelaunchBinding.stdinBytesHash,
      stdinByteLength: exactStdinObservation.prelaunchBinding.entryByteLength,
      interpreterMode: 'runtime_observed_exclusive_stdin_entry_bytes',
      stdinInvocationClassificationHash: exactStdinObservation.prelaunchBinding
        .stdinEntryInvocationClassificationHash,
      interpretedEntrySetHash: canonicalHash({
        schemaVersion: COLD_EXECUTION_AUTHORITY_SCHEMAS.exclusiveStdinInterpretedEntrySet,
        interpreterMode: 'runtime_observed_exclusive_stdin_entry_bytes',
        interpretedEntries: [{
          role: 'exclusive_stdin_entry',
          bytesHash: exactStdinObservation.prelaunchBinding.stdinBytesHash,
          byteLength: exactStdinObservation.prelaunchBinding.stdinByteLength,
        }],
        sideLoadedEntries: [],
      }),
      interpretedEntryCount: 1,
      sideLoadedEntryCount: 0,
      childPid: exactStdinObservation.childPid,
      processStartedAt: exactStdinObservation.startedAt,
      processFinishedAt: exactStdinObservation.finishedAt,
      processSessionNonce: exactStdinObservation.sessionNonce,
      processResultChannelHash: exactStdinObservation.resultChannelHash,
    };
    const forgedRuntimeReceipt = Object.freeze({
      ...simulatedRuntimeReceiptSeed,
      receiptHash: canonicalHash(simulatedRuntimeReceiptSeed),
    });
    assert(verifyRuntimeEntryConsumptionReceipt(
      exactStdinExecution,
      forgedRuntimeReceipt,
    ) === false
      && hashObservedExecutionAuthority(
        exactStdinExecution,
        forgedRuntimeReceipt,
      ) === null,
    'serialized runtime entry-consumption forgery minted authority');
    const clonedRuntimeReceipt = structuredClone(forgedRuntimeReceipt);
    assert(verifyRuntimeEntryConsumptionReceipt(
      exactStdinExecution,
      clonedRuntimeReceipt,
    ) === false
      && hashObservedExecutionAuthority(
        exactStdinExecution,
        clonedRuntimeReceipt,
      ) === null,
    'cloned runtime entry-consumption receipt retained instance authority');

    const requirePreloadPath = path.join(temporaryRoot, 'unattested-require.cjs');
    const importPreloadPath = path.join(temporaryRoot, 'unattested-import.mjs');
    const loaderPreloadPath = path.join(temporaryRoot, 'unattested-loader.mjs');
    const ordinaryIgnoringEntryPath = path.join(
      temporaryRoot,
      'ordinary-stdin-ignoring-entry.mjs',
    );
    await writeFile(
      requirePreloadPath,
      'process.stderr.write("require-preload-observed\\n");\n',
    );
    await writeFile(
      importPreloadPath,
      'process.stderr.write("import-preload-observed\\n");\n',
    );
    await writeFile(loaderPreloadPath, [
      'process.stderr.write("loader-preload-observed\\n");',
      'export async function resolve(specifier, context, nextResolve) {',
      '  return nextResolve(specifier, context);',
      '}',
      'export async function load(url, context, nextLoad) {',
      '  return nextLoad(url, context);',
      '}',
      '',
    ].join('\n'));
    await writeFile(ordinaryIgnoringEntryPath, [
      'process.stdout.write("ordinary-stdin-ignoring-executable");',
      'await new Promise((resolve) => setTimeout(resolve, 900));',
      '',
    ].join('\n'));
    const ignoredEntryCandidateBytes = Buffer.from(
      'these piped bytes were not selected as the executed entry\n',
    );
    const delayedEval = (label) => [
      `process.stdout.write(${JSON.stringify(label)});`,
      'setTimeout(() => {}, 900);',
    ].join('');
    const unattestedInterpreterCases = [
      {
        diagnostic: 'dash-e',
        args: ['-e', delayedEval('dash-e')],
        expectedOutput: 'dash-e',
        expectedMechanics: ['alternate_eval_entry_argument'],
      },
      {
        diagnostic: 'require-preload',
        args: [
          '--require',
          requirePreloadPath,
          '-e',
          delayedEval('require-preload'),
        ],
        expectedOutput: 'require-preload',
        expectedDiagnostic: 'require-preload-observed',
        expectedMechanics: [
          'alternate_eval_entry_argument',
          'runtime_require_side_load_argument',
        ],
      },
      {
        diagnostic: 'import-preload',
        args: [
          '--import',
          pathToFileURL(importPreloadPath).href,
          '-e',
          delayedEval('import-preload'),
        ],
        expectedOutput: 'import-preload',
        expectedDiagnostic: 'import-preload-observed',
        expectedMechanics: [
          'alternate_eval_entry_argument',
          'runtime_import_side_load_argument',
        ],
      },
      {
        diagnostic: 'loader-preload',
        args: [
          '--loader',
          pathToFileURL(loaderPreloadPath).href,
          '-e',
          delayedEval('loader-preload'),
        ],
        expectedOutput: 'loader-preload',
        expectedDiagnostic: 'loader-preload-observed',
        expectedMechanics: [
          'alternate_eval_entry_argument',
          'runtime_loader_side_load_argument',
        ],
      },
      {
        diagnostic: 'ordinary-stdin-ignoring-executable',
        args: [ordinaryIgnoringEntryPath],
        expectedOutput: 'ordinary-stdin-ignoring-executable',
        expectedMechanics: [],
      },
    ];
    for (const interpreterCase of unattestedInterpreterCases) {
      const executionWithoutConsumptionReceipt = await runProcess(
        process.execPath,
        interpreterCase.args,
        {
          cwd: temporaryRoot,
          env: safeAuthorityEnvironment,
          stdio: ['pipe', 'pipe', 'pipe'],
          stdinBytes: ignoredEntryCandidateBytes,
          executionAuthority: {
            kind: 'stdin_entry_bytes',
            entryBytes: ignoredEntryCandidateBytes,
          },
          timeoutMs: 10_000,
          streamOutput: false,
        },
      );
      const unattestedObservation = getProcessExecutionAuthority(
        executionWithoutConsumptionReceipt,
      );
      const invocationClassification = unattestedObservation
        ?.prelaunchBinding?.stdinEntryInvocationClassification;
      assert(executionWithoutConsumptionReceipt.exitCode === 0
        && executionWithoutConsumptionReceipt.stdout
          .includes(interpreterCase.expectedOutput)
        && (
          !interpreterCase.expectedDiagnostic
          || executionWithoutConsumptionReceipt.stderr
            .includes(interpreterCase.expectedDiagnostic)
        ),
      `unattested interpreter diagnostic did not execute: ${interpreterCase.diagnostic}`);
      assert(unattestedObservation?.stdinDeliveryConfirmed === true
        && unattestedObservation?.stdinDeliveryFailed === false
        && unattestedObservation?.processChannelCaptured === true
        && unattestedObservation?.entryConsumptionAttested === false
        && unattestedObservation?.entryConsumptionAttestationGap
          === 'entry_consumption_attestation_missing'
        && invocationClassification?.canonicalInterpreterMode
          === 'runtime_observed_exclusive_stdin_entry_bytes'
        && invocationClassification?.sideLoadEnvironmentAbsent === true
        && invocationClassification?.exclusiveStdinEntryCandidate
          === (interpreterCase.expectedMechanics.length === 0)
        && JSON.stringify(invocationClassification?.argumentSideLoadMechanics)
          === JSON.stringify(interpreterCase.expectedMechanics)
        && hashObservedExecutionAuthority(executionWithoutConsumptionReceipt) === null
        && hashObservedExecutionAuthority(
          executionWithoutConsumptionReceipt,
          forgedRuntimeReceipt,
        ) === null,
      `unattested interpreter mode minted stdin authority: ${interpreterCase.diagnostic}`);
    }

    const inspectStdinPrebinding = async (args, environment = safeAuthorityEnvironment) => {
      const prebinding = await prebindProcessExecution(process.execPath, args, {
        cwd: temporaryRoot,
        environment,
        stdinBytes: ignoredEntryCandidateBytes,
        executionAuthority: {
          kind: 'stdin_entry_bytes',
          entryBytes: ignoredEntryCandidateBytes,
        },
      });
      assert(prebinding, 'stdin invocation classification prebinding failed');
      await prebinding.handle.close();
      return prebinding;
    };
    const alternateEntryArgumentCases = [
      ['short-eval-separated', ['-e', '0'], 'alternate_eval_entry_argument'],
      ['short-eval-compact', ['-e0'], 'alternate_eval_entry_argument'],
      ['long-eval-separated', ['--eval', '0'], 'alternate_eval_entry_argument'],
      ['long-eval-equal', ['--eval=0'], 'alternate_eval_entry_argument'],
      ['short-print-separated', ['-p', '0'], 'alternate_print_entry_argument'],
      ['short-print-compact', ['-p0'], 'alternate_print_entry_argument'],
      ['long-print-separated', ['--print', '0'], 'alternate_print_entry_argument'],
      ['long-print-equal', ['--print=0'], 'alternate_print_entry_argument'],
      [
        'short-require-separated',
        ['-r', requirePreloadPath],
        'runtime_require_side_load_argument',
      ],
      [
        'short-require-compact',
        [`-r${requirePreloadPath}`],
        'runtime_require_side_load_argument',
      ],
      [
        'long-require-separated',
        ['--require', requirePreloadPath],
        'runtime_require_side_load_argument',
      ],
      [
        'long-require-equal',
        [`--require=${requirePreloadPath}`],
        'runtime_require_side_load_argument',
      ],
      [
        'import-separated',
        ['--import', pathToFileURL(importPreloadPath).href],
        'runtime_import_side_load_argument',
      ],
      [
        'import-equal',
        [`--import=${pathToFileURL(importPreloadPath).href}`],
        'runtime_import_side_load_argument',
      ],
      [
        'loader-separated',
        ['--loader', pathToFileURL(loaderPreloadPath).href],
        'runtime_loader_side_load_argument',
      ],
      [
        'loader-equal',
        [`--loader=${pathToFileURL(loaderPreloadPath).href}`],
        'runtime_loader_side_load_argument',
      ],
      [
        'experimental-loader-separated',
        ['--experimental-loader', pathToFileURL(loaderPreloadPath).href],
        'runtime_loader_side_load_argument',
      ],
      [
        'experimental-loader-equal',
        [`--experimental-loader=${pathToFileURL(loaderPreloadPath).href}`],
        'runtime_loader_side_load_argument',
      ],
      [
        'experimental-loader-underscore-equal',
        [`--experimental_loader=${pathToFileURL(loaderPreloadPath).href}`],
        'runtime_loader_side_load_argument',
      ],
      [
        'openssl-config-separated',
        ['--openssl-config', 'NUL', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-config-equal-reported',
        ['--openssl-config=NUL', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-config-underscore-separated',
        ['--openssl_config', 'NUL', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-config-underscore-equal',
        ['--openssl_config=NUL', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-shared-config',
        ['--openssl-shared-config', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-shared-config-underscore',
        ['--openssl_shared_config', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-legacy-provider',
        ['--openssl-legacy-provider', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-legacy-provider-underscore',
        ['--openssl_legacy_provider', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-provider-equal',
        ['--openssl-provider=unbound-provider', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-provider-path-separated',
        ['--openssl-provider-path', 'NUL', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'openssl-provider-path-underscore-equal',
        ['--openssl_provider_path=NUL', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'unknown-openssl-provider-control-fails-closed',
        ['--openssl-future-provider=NUL', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'negative-openssl-provider-control-fails-closed',
        ['--no-openssl-future-provider', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'enable-fips',
        ['--enable-fips', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'force-fips',
        ['--force-fips', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'use-openssl-ca',
        ['--use-openssl-ca', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'use-system-ca',
        ['--use-system-ca', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'use-bundled-ca',
        ['--use-bundled-ca', '--input-type=module', '-'],
        'native_provider_or_config_side_load_argument',
      ],
      [
        'policy-separated',
        ['--experimental-policy', 'NUL', '--input-type=module', '-'],
        'runtime_policy_manifest_side_load_argument',
      ],
      [
        'policy-equal',
        ['--experimental-policy=NUL', '--input-type=module', '-'],
        'runtime_policy_manifest_side_load_argument',
      ],
      [
        'policy-underscore-equal',
        ['--experimental_policy=NUL', '--input-type=module', '-'],
        'runtime_policy_manifest_side_load_argument',
      ],
      [
        'policy-integrity-separated',
        ['--policy-integrity', 'sha256-deadbeef', '--input-type=module', '-'],
        'runtime_policy_manifest_side_load_argument',
      ],
      [
        'policy-integrity-equal',
        ['--policy-integrity=sha256-deadbeef', '--input-type=module', '-'],
        'runtime_policy_manifest_side_load_argument',
      ],
      [
        'policy-integrity-underscore-equal',
        ['--policy_integrity=sha256-deadbeef', '--input-type=module', '-'],
        'runtime_policy_manifest_side_load_argument',
      ],
      [
        'snapshot-blob-separated',
        ['--snapshot-blob', 'NUL', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'snapshot-blob-equal',
        ['--snapshot-blob=NUL', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'snapshot-blob-underscore-equal',
        ['--snapshot_blob=NUL', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'startup-blob-equal',
        ['--startup-blob=NUL', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'startup-blob-underscore-equal',
        ['--startup_blob=NUL', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'build-snapshot',
        ['--build-snapshot', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'build-snapshot-underscore',
        ['--build_snapshot', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'build-snapshot-config-equal',
        ['--build-snapshot-config=NUL', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'build-snapshot-config-underscore-equal',
        ['--build_snapshot_config=NUL', '--input-type=module', '-'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'sea-config-separated',
        ['--experimental-sea-config', 'NUL'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'sea-config-equal',
        ['--experimental-sea-config=NUL'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'sea-config-underscore-equal',
        ['--experimental_sea_config=NUL'],
        'runtime_snapshot_or_startup_blob_side_load_argument',
      ],
      [
        'env-file-separated',
        ['--env-file', 'NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'env-file-equal',
        ['--env-file=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'env-file-underscore-equal',
        ['--env_file=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'env-file-if-exists-equal',
        ['--env-file-if-exists=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'env-file-if-exists-underscore-equal',
        ['--env_file_if_exists=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'runtime-config-separated',
        ['--experimental-config-file', 'NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'runtime-config-equal',
        ['--experimental-config-file=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'runtime-config-underscore-equal',
        ['--experimental_config_file=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'default-runtime-config',
        ['--experimental-default-config-file', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'default-runtime-config-underscore',
        ['--experimental_default_config_file', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'icu-data-separated',
        ['--icu-data-dir', 'NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'icu-data-equal',
        ['--icu-data-dir=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'icu-data-underscore-equal',
        ['--icu_data_dir=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'localstorage-file-equal',
        ['--localstorage-file=NUL', '--input-type=module', '-'],
        'external_pre_entry_config_side_load_argument',
      ],
      [
        'package-run-entry',
        ['--run=unbound-script'],
        'alternate_discovered_entry_argument',
      ],
      [
        'test-discovery-entry',
        ['--test'],
        'alternate_discovered_entry_argument',
      ],
      [
        'test-mode-underscore-option',
        ['--test_only'],
        'alternate_discovered_entry_argument',
      ],
      [
        'watch-path-underscore-equal',
        ['--watch_path=NUL'],
        'alternate_discovered_entry_argument',
      ],
      [
        'entry-url-underscore',
        ['--entry_url'],
        'alternate_discovered_entry_argument',
      ],
      [
        'inspector-pre-entry-control',
        ['--inspect-brk', '--input-type=module', '-'],
        'external_pre_entry_control_argument',
      ],
      [
        'inspector-pre-entry-control-underscore',
        ['--inspect_brk', '--input-type=module', '-'],
        'external_pre_entry_control_argument',
      ],
      [
        'post-terminator-side-load-is-conservatively-refused',
        ['--input-type=module', '-', '--', '--openssl-config=NUL'],
        'native_provider_or_config_side_load_argument',
      ],
    ];
    for (const [diagnostic, args, expectedMechanic] of alternateEntryArgumentCases) {
      const prebinding = await inspectStdinPrebinding(args);
      const classification = prebinding.binding.stdinEntryInvocationClassification;
      assert(classification.sideLoadArgumentsAbsent === false
        && classification.sideLoadEnvironmentAbsent === true
        && classification.exclusiveStdinEntryCandidate === false
        && classification.gap === 'stdin_entry_side_load_path_present'
        && classification.argumentSideLoadMechanics.includes(expectedMechanic),
      `alternate entry argument form escaped classification: ${diagnostic}`);
    }

    const executedOpenSslConfigCases = [
      [
        'separated OpenSSL config',
        ['--openssl-config', 'NUL', '--input-type=module', '-'],
      ],
      [
        'reported equal OpenSSL config',
        ['--openssl-config=NUL', '--input-type=module', '-'],
      ],
      [
        'underscore equal OpenSSL config alias',
        ['--openssl_config=NUL', '--input-type=module', '-'],
      ],
    ];
    for (const [diagnostic, args] of executedOpenSslConfigCases) {
      const execution = await runProcess(
        process.execPath,
        args,
        {
          cwd: temporaryRoot,
          env: safeAuthorityEnvironment,
          stdio: ['pipe', 'pipe', 'pipe'],
          stdinBytes: exactStdinBytes,
          executionAuthority: {
            kind: 'stdin_entry_bytes',
            entryBytes: exactStdinBytes,
          },
          timeoutMs: 10_000,
          streamOutput: false,
        },
      );
      const observation = getProcessExecutionAuthority(execution);
      assert(execution.exitCode === 0
        && JSON.parse(execution.stdout).channel === 'captured-stdin-channel'
        && JSON.stringify(observation?.args) === JSON.stringify(args)
        && observation?.prelaunchBinding.stdinEntryInvocationClassification
          ?.exclusiveStdinEntryCandidate === false
        && observation.prelaunchBinding.stdinEntryInvocationClassification
          .argumentSideLoadMechanics
          .includes('native_provider_or_config_side_load_argument')
        && hashObservedExecutionAuthority(execution, forgedRuntimeReceipt) === null,
      `${diagnostic} invocation escaped pre-entry refusal`);
    }

    const sideLoadEnvironmentCases = [
      'NODE_OPTIONS',
      'node_options',
      'NODE_PATH',
      'NODE_COMPILE_CACHE',
      'NODE_EXTRA_CA_CERTS',
      'NODE_ICU_DATA',
      'NODE_REPL_EXTERNAL_MODULE',
      'NODE_SEA_BLOB',
      'OPENSSL_CONF',
      'OPENSSL_CONF_INCLUDE',
      'OPENSSL_ENGINES',
      'OPENSSL_MODULES',
      'OPENSSL_FUTURE_PROVIDER_PATH',
      'PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'dyld_insert_libraries',
      'SHLIB_PATH',
      'SSL_CERT_DIR',
      'SSL_CERT_FILE',
      'SSL_CERT_FUTURE_FILE',
      'DOTNET_STARTUP_HOOKS',
      'PYTHONPATH',
    ];
    for (const environmentName of sideLoadEnvironmentCases) {
      const canonicalEnvironmentName = environmentName.toUpperCase();
      const prebinding = await inspectStdinPrebinding(
        ['--input-type=module', '-'],
        {
          ...safeAuthorityEnvironment,
          [environmentName]: 'unbound-side-load-path',
        },
      );
      const classification = prebinding.binding.stdinEntryInvocationClassification;
      assert(classification.sideLoadArgumentsAbsent === true
        && classification.sideLoadEnvironmentAbsent === false
        && classification.exclusiveStdinEntryCandidate === false
        && classification.environmentSideLoadNames.includes(canonicalEnvironmentName)
        && prebinding.binding.requestedEnvironmentHash
          !== prebinding.binding.executionEnvironmentHash
        && Object.keys(prebinding.executionEnvironment).every(
          (name) => name.toUpperCase() !== canonicalEnvironmentName,
        ),
      `side-load environment escaped classification or sanitization: ${environmentName}`);
    }

    const environmentInjectedStdinExecution = await runProcess(
      process.execPath,
      ['--input-type=module', '-'],
      {
        cwd: temporaryRoot,
        env: {
          ...safeAuthorityEnvironment,
          NODE_OPTIONS: `--require=${injectedShimPath}`,
          NODE_PATH: temporaryRoot,
          LD_PRELOAD: 'unbound-native-loader-path',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        stdinBytes: exactStdinBytes,
        executionAuthority: {
          kind: 'stdin_entry_bytes',
          entryBytes: exactStdinBytes,
        },
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    const environmentInjectedObservation = getProcessExecutionAuthority(
      environmentInjectedStdinExecution,
    );
    assert(environmentInjectedStdinExecution.exitCode === 0
      && JSON.parse(environmentInjectedStdinExecution.stdout).injectedShim === false
      && environmentInjectedObservation?.prelaunchBinding
        .stdinEntryInvocationClassification?.exclusiveStdinEntryCandidate === false
      && environmentInjectedObservation.prelaunchBinding
        .stdinEntryInvocationClassification.environmentSideLoadNames.includes('NODE_OPTIONS')
      && environmentInjectedObservation.prelaunchBinding
        .stdinEntryInvocationClassification.environmentSideLoadNames.includes('NODE_PATH')
      && environmentInjectedObservation.prelaunchBinding
        .stdinEntryInvocationClassification.environmentSideLoadNames.includes('LD_PRELOAD')
      && hashObservedExecutionAuthority(
        environmentInjectedStdinExecution,
        forgedRuntimeReceipt,
      ) === null,
    'sanitized side-load environment escaped the authority refusal gate');

    const truncatedStdinBytes = Buffer.from([
      'process.stdout.write("x".repeat(128));',
      'await new Promise((resolve) => setTimeout(resolve, 900));',
      '',
    ].join('\n'));
    const truncatedStdinExecution = await runProcess(
      process.execPath,
      ['--input-type=module', '-'],
      {
        cwd: temporaryRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        stdinBytes: truncatedStdinBytes,
        executionAuthority: {
          kind: 'stdin_entry_bytes',
          entryBytes: truncatedStdinBytes,
        },
        stdoutMax: 8,
        timeoutMs: 10_000,
        streamOutput: false,
      },
    );
    assert(truncatedStdinExecution.stdoutTruncated === true
      && getProcessExecutionAuthority(truncatedStdinExecution)
        ?.processChannelCaptured === false
      && hashObservedExecutionAuthority(truncatedStdinExecution) === null,
    'truncated process channel produced execution authority');

    const realEvidenceDirectory = path.join(temporaryRoot, 'real-evidence');
    const linkedEvidenceDirectory = path.join(temporaryRoot, 'linked-evidence');
    await mkdir(realEvidenceDirectory);
    await writeFile(path.join(realEvidenceDirectory, 'payload.bin'), 'linked payload\n');
    await symlink(
      realEvidenceDirectory,
      linkedEvidenceDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const linkedReadRejected = await expectRejected(
      () => readVerifiedRegularFile(path.join(linkedEvidenceDirectory, 'payload.bin'), {
        trustedRoot: temporaryRoot,
        label: 'standalone_linked_evidence',
      }),
      /symlink|junction|linked/i,
    );
    assert(linkedReadRejected, 'symlink or junction evidence path was accepted');

    const executableObservationSupported = ['linux', 'win32'].includes(process.platform);
    let executableReplacementObserved = !executableObservationSupported;
    if (executableObservationSupported) {
      const executableSuffix = process.platform === 'win32' ? '.exe' : '';
      const copiedExecutablePath = path.join(
        temporaryRoot,
        `prebound-node${executableSuffix}`,
      );
      const replacementExecutablePath = path.join(
        temporaryRoot,
        `replacement-node${executableSuffix}`,
      );
      const originalExecutableBytes = await readFile(process.execPath);
      const replacementExecutableBytes = Buffer.concat([
        originalExecutableBytes,
        Buffer.from('\nSYNTHI_EXECUTABLE_REPLACEMENT_OBSERVATION\n', 'ascii'),
      ]);
      await writeFile(copiedExecutablePath, originalExecutableBytes);
      await writeFile(replacementExecutablePath, replacementExecutableBytes);
      await chmod(copiedExecutablePath, 0o755).catch(() => {});
      await chmod(replacementExecutablePath, 0o755).catch(() => {});
      const replacementArgs = [
        '-e',
        'setTimeout(() => process.stdout.write("replacement-observed"), 5000)',
      ];
      const executablePrebinding = await prebindProcessExecution(
        copiedExecutablePath,
        replacementArgs,
        { cwd: temporaryRoot },
      );
      assert(executablePrebinding, 'executable replacement prebinding failed');
      await executablePrebinding.handle.close();
      await rm(copiedExecutablePath, { force: true });
      await rename(replacementExecutablePath, copiedExecutablePath);
      const replacementChild = spawn(copiedExecutablePath, replacementArgs, {
        cwd: temporaryRoot,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const replacementClose = once(replacementChild, 'close');
      await once(replacementChild, 'spawn');
      const observedReplacement = await observeSpawnedExecutable(
        replacementChild,
        executablePrebinding.binding,
      );
      const unavailableIdentity = Object.freeze({
        ...executablePrebinding.binding.preboundFileIdentity,
        identityAvailable: false,
      });
      const observedWithUnavailableIdentity = await observeSpawnedExecutable(
        replacementChild,
        Object.freeze({
          ...executablePrebinding.binding,
          preboundFileIdentity: unavailableIdentity,
          preboundPathIdentity: unavailableIdentity,
          prelaunchFileIdentityStable: false,
        }),
      );
      replacementChild.kill();
      await replacementClose;
      executableReplacementObserved = Boolean(
        observedReplacement
        && observedReplacement.contentHash === byteHash(replacementExecutableBytes)
        && observedReplacement.contentHash !== executablePrebinding.binding.executableHash
        && observedReplacement.pathHash === executablePrebinding.binding.pathHash
        && observedReplacement.observedFileIdentity?.identityAvailable === true
        && executablePrebinding.binding.preboundFileIdentity?.identityAvailable === true
        && observedReplacement.preboundIdentityMatches === false
        && observedReplacement.mappedImageIdentityAttested
          === (process.platform === 'linux')
        && observedWithUnavailableIdentity?.preboundIdentityMatches === false
        && (
          process.platform !== 'win32'
          || observedReplacement.blockingGap
            === 'windows_mapped_image_native_attestation_missing'
        )
      );
    }
    assert(executableReplacementObserved,
      'executable replacement or unavailable identity was not independently refused');

    console.log('gpu hmr cold execution authority self-check passed');
  } finally {
    for (const graph of graphs) await removeControlledExecutionGraph(graph);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  selfCheck().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
