import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProxy } from "node:util/types";
import * as coldExecutionAuthorityModule
  from "../scripts/lib/gpu-hmr-cold-execution-authority.mjs";
import {
  GPU_MCP_OUTPUT_EVALUATOR_FUNCTION_SOURCE_IDENTITY_DOMAIN,
  GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_AUTHORITY,
  GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA,
  gpuMcpOutputEvaluatorCapabilityMatchesExecutorClaim,
  gpuMcpOutputEvaluatorMaterial,
  snapshotGpuMcpOutputEvaluatorMaterialBytes,
  type GpuMcpOutputEvaluatorCapability,
  type GpuMcpOutputEvaluatorExecutorClaim,
  type GpuMcpOutputEvaluatorMaterial,
} from "./gpu_mcp_output_evaluation.js";
import {
  snapshotValidatedUint8Array,
} from "./validated_uint8_array.js";

export const GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_SCHEMA =
  "synthi.gpu_hmr.mcp_output_evaluator_fresh_process_execution.v1" as const;
export const GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_AUTHORITY =
  "fresh_process_static_graph_execution_support_only_not_admission_or_gpu_hmr_acceptance" as const;

const RESULT_SCHEMA =
  "synthi.gpu_hmr.mcp_output_evaluator_fresh_process_result.v1";
const ENTRY_RELATIVE_PATH = "entry.mjs";
const MATERIAL_RELATIVE_PATH = "input/evaluator-material.json";
const OUTPUT_RELATIVE_PATH = "input/observed-output.bin";
const RESULT_RELATIVE_PATH = "result/evaluation.json";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_CAPTURED_STREAM_BYTES = 8_192;
const CANONICAL_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MATERIAL_DOCUMENT_KEYS = [
  "schemaVersion",
  "evaluatorFunctionSourceSha256",
  "evaluatorSourceSha256",
  "evaluatorSourceByteLength",
  "evaluatorSource",
  "outputContractSha256",
  "outputSemanticsSha256",
] as const;
const RESULT_KEYS = [
  "schemaVersion",
  "evaluatorMaterialSha256",
  "evaluatorMaterialByteLength",
  "outputContentSha256",
  "outputByteLength",
  "outputContractPassed",
] as const;

const freeze = Object.freeze;
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;
const reflectApply = Reflect.apply;
const createHashIntrinsic = createHash;
const hashPrototype = Object.getPrototypeOf(
  createHashIntrinsic("sha256"),
);
const hashUpdate = hashPrototype.update as Function;
const hashDigest = hashPrototype.digest as Function;
const bufferByteLength = Buffer.byteLength;
const bufferFrom = Buffer.from;
const uint8ArrayFill = Uint8Array.prototype.fill;

type ControlledExecutionGraph = Readonly<{
  readonly graphHash: string;
  readonly entries: readonly Readonly<{
    readonly relativePath: string;
    readonly contentHash: string;
    readonly byteLength: number;
  }>[];
}>;

type ControlledExecutionResult = Readonly<{
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
  readonly childPid: number | null;
  readonly startedMonotonicNs: string;
  readonly finishedMonotonicNs: string;
}>;

type ControlledResultReceipt = Readonly<{
  readonly resultBytesHash: string;
  readonly resultByteLength: number;
  readonly receiptHash: string;
  readonly bytes: Buffer;
}>;

type ProcessObservation = Readonly<{
  readonly schemaVersion: string;
  readonly childPid: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly sessionNonce: string;
  readonly prelaunchBinding?: Readonly<{
    readonly invocationHash?: string;
    readonly executableHash?: string;
    readonly requestedEnvironmentHash?: string;
    readonly executionEnvironmentHash?: string;
    readonly registeredOutputsHash?: string;
  }> | null;
  readonly spawnedExecutableHash: string | null;
  readonly executableIdentityStable: boolean;
  readonly executionGraphHash: string | null;
  readonly executionGraphStable: boolean | null;
  readonly loadedGraphIdentityAttested: boolean | null;
  readonly loadedGraphIdentityGap: string | null;
  readonly processChannelCaptured: boolean;
  readonly stdoutBytesHash: string;
  readonly stdoutByteLength: number;
  readonly stderrBytesHash: string;
  readonly stderrByteLength: number;
  readonly parentMonotonicInterval: Readonly<{
    readonly clockDomain: string;
    readonly startNs: string;
    readonly endNs: string;
  }>;
  readonly resultChannelHash: string;
}>;

const coldExecutionAuthority =
  coldExecutionAuthorityModule as unknown as Readonly<{
    createControlledExecutionGraph: (
      options: Readonly<{
        trustedRoot: string;
        entryRelativePath: string;
        entryBytes: Buffer;
        moduleEntryPaths: readonly string[];
        supportFilePaths: readonly string[];
        moduleEntries: readonly unknown[];
        supportEntries: readonly Readonly<{
          relativePath: string;
          bytes: Buffer;
        }>[];
      }>,
    ) => Promise<ControlledExecutionGraph>;
    controlledExecutionGraphEntryPath: (
      graph: ControlledExecutionGraph,
    ) => string | null;
    controlledExecutionGraphRoot: (
      graph: ControlledExecutionGraph,
    ) => string | null;
    getProcessExecutionAuthority: (
      result: ControlledExecutionResult,
    ) => ProcessObservation | null;
    readRegisteredGraphResultReceipt: (
      input: Readonly<{
        executionResult: ControlledExecutionResult;
        graph: ControlledExecutionGraph;
        resultPath: string;
      }>,
    ) => Promise<ControlledResultReceipt | null>;
    registerControlledExecutionOutput: (
      graph: ControlledExecutionGraph,
      sourcePath: string,
    ) => string | null;
    removeControlledExecutionGraph: (
      graph: ControlledExecutionGraph,
    ) => Promise<boolean>;
    runProcess: (
      command: string,
      args: readonly string[],
      options: Readonly<Record<string, unknown>>,
    ) => Promise<ControlledExecutionResult>;
    verifyControlledExecutionGraph: (
      graph: ControlledExecutionGraph,
      options?: Readonly<{ requireOutputs?: boolean }>,
    ) => Promise<boolean>;
    verifyRegisteredGraphResultReceipt: (
      executionResult: ControlledExecutionResult,
      receipt: ControlledResultReceipt,
    ) => boolean;
  }>;

export interface GpuMcpOutputEvaluatorFreshProcessOptions {
  readonly timeoutMs?: number;
}

export interface GpuMcpOutputEvaluatorFreshProcessExecution {
  readonly schemaVersion:
    typeof GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_SCHEMA;
  readonly proofAuthority:
    typeof GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_AUTHORITY;
  readonly evaluatorMaterialSha256: string;
  readonly evaluatorMaterialByteLength: string;
  readonly evaluatorFunctionSourceSha256: string;
  readonly evaluatorSourceSha256: string;
  readonly outputContractSha256: string;
  readonly outputSemanticsSha256: string | null;
  readonly outputContentSha256: string;
  readonly outputByteLength: string;
  readonly executionEntrypointSha256: string;
  readonly executionEntrypointByteLength: string;
  readonly executionGraphHash: string;
  readonly processObservationHash: string;
  readonly resultContentSha256: string;
  readonly resultByteLength: string;
  readonly executionStartedMonotonicNs: string;
  readonly executionFinishedMonotonicNs: string;
  readonly timeoutMs: number;
  readonly timedOut: false;
  readonly exitCode: 0;
  readonly outputContractPassed: boolean;
  readonly freshProcessExecutionObserved: true;
  readonly parentClosureUnavailable: true;
  readonly staticExecutionGraphVerified: true;
  readonly loadedGraphIdentityAttested: false;
  readonly loadedGraphIdentityGap:
    "runtime_loaded_graph_identity_attestation_missing";
  readonly isolatedExecutionVerified: false;
  readonly containerAttestationVerified: false;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

interface MaterialDocument {
  readonly schemaVersion: string;
  readonly evaluatorFunctionSourceSha256: string;
  readonly evaluatorSourceSha256: string;
  readonly evaluatorSourceByteLength: string;
  readonly evaluatorSource: string;
  readonly outputContractSha256: string;
  readonly outputSemanticsSha256: string | null;
}

interface FreshProcessResult {
  readonly schemaVersion: typeof RESULT_SCHEMA;
  readonly evaluatorMaterialSha256: string;
  readonly evaluatorMaterialByteLength: string;
  readonly outputContentSha256: string;
  readonly outputByteLength: string;
  readonly outputContractPassed: boolean;
}

function sha256Hex(
  ...values: readonly (string | Uint8Array)[]
): string {
  const hash = createHashIntrinsic("sha256");
  for (const value of values) {
    reflectApply(
      hashUpdate,
      hash,
      typeof value === "string" ? [value, "utf8"] : [value],
    );
  }
  return reflectApply(hashDigest, hash, ["hex"]) as string;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${sha256Hex(value)}`;
}

function fillBytes(bytes: Uint8Array): void {
  try {
    reflectApply(uint8ArrayFill, bytes, [0]);
  } catch {
    // Detached buffers expose no bytes to clear.
  }
}

function exactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || isProxy(value)
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expectedKeys.length
      || keys.some(
        (key, index) =>
          typeof key !== "string" || key !== expectedKeys[index],
      )
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function timeoutMs(
  optionsValue: GpuMcpOutputEvaluatorFreshProcessOptions | undefined,
): number {
  if (optionsValue === undefined) return DEFAULT_TIMEOUT_MS;
  const emptyOptions = exactPlainRecord(optionsValue, []);
  if (emptyOptions !== null) return DEFAULT_TIMEOUT_MS;
  const options = exactPlainRecord(optionsValue, ["timeoutMs"]);
  if (options === null) {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_options_invalid",
    );
  }
  const value = options.timeoutMs;
  if (
    !Number.isSafeInteger(value)
    || (value as number) <= 0
    || (value as number) > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_timeout_invalid",
    );
  }
  return value as number;
}

function validatedMaterialFromBytes(
  bytes: Uint8Array,
): Readonly<{
  material: GpuMcpOutputEvaluatorMaterial;
  document: MaterialDocument;
}> {
  const text = bufferFrom(bytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = reflectApply(jsonParse, JSON, [text]);
  } catch {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_material_invalid",
    );
  }
  const record = exactPlainRecord(parsed, MATERIAL_DOCUMENT_KEYS);
  const evaluatorSource = record?.evaluatorSource;
  const outputSemanticsSha256 = record?.outputSemanticsSha256;
  if (
    record === null
    || reflectApply(jsonStringify, JSON, [record]) !== text
    || record.schemaVersion !== GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA
    || typeof evaluatorSource !== "string"
    || typeof record.evaluatorFunctionSourceSha256 !== "string"
    || !CANONICAL_SHA256_PATTERN.test(
      record.evaluatorFunctionSourceSha256,
    )
    || record.evaluatorFunctionSourceSha256
      !== `sha256:${sha256Hex(
        GPU_MCP_OUTPUT_EVALUATOR_FUNCTION_SOURCE_IDENTITY_DOMAIN,
        "\0",
        evaluatorSource,
      )}`
    || typeof record.evaluatorSourceSha256 !== "string"
    || !CANONICAL_SHA256_PATTERN.test(record.evaluatorSourceSha256)
    || sha256(evaluatorSource) !== record.evaluatorSourceSha256
    || typeof record.evaluatorSourceByteLength !== "string"
    || String(bufferByteLength(evaluatorSource, "utf8"))
      !== record.evaluatorSourceByteLength
    || typeof record.outputContractSha256 !== "string"
    || !CANONICAL_SHA256_PATTERN.test(record.outputContractSha256)
    || (
      outputSemanticsSha256 !== null
      && (
        typeof outputSemanticsSha256 !== "string"
        || !CANONICAL_SHA256_PATTERN.test(outputSemanticsSha256)
      )
    )
  ) {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_material_invalid",
    );
  }
  const document = freeze(record) as unknown as MaterialDocument;
  const material = freeze({
    schemaVersion: GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA,
    proofAuthority: GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_AUTHORITY,
    materialSha256: sha256(bytes),
    materialByteLength: String(bytes.byteLength),
    evaluatorFunctionSourceSha256:
      document.evaluatorFunctionSourceSha256,
    evaluatorSourceSha256: document.evaluatorSourceSha256,
    evaluatorSourceByteLength: document.evaluatorSourceByteLength,
    outputContractSha256: document.outputContractSha256,
    outputSemanticsSha256: document.outputSemanticsSha256,
    isolatedExecutionRequired: true as const,
    isolatedExecutionVerified: false as const,
    acceptedForGpuHmr: false as const,
    gpuHmrSuccess: false as const,
    canSatisfyRuntimeProof: false as const,
  });
  return freeze({ material, document });
}

function validateMaterial(
  material: GpuMcpOutputEvaluatorMaterial,
  bytes: Uint8Array,
): Readonly<{
  material: GpuMcpOutputEvaluatorMaterial;
  document: MaterialDocument;
}> {
  const validated = validatedMaterialFromBytes(bytes);
  if (
    material.schemaVersion !== validated.material.schemaVersion
    || material.proofAuthority !== validated.material.proofAuthority
    || material.materialSha256
      !== validated.material.materialSha256
    || material.materialByteLength
      !== validated.material.materialByteLength
    || material.evaluatorFunctionSourceSha256
      !== validated.material.evaluatorFunctionSourceSha256
    || material.evaluatorSourceSha256
      !== validated.material.evaluatorSourceSha256
    || material.evaluatorSourceByteLength
      !== validated.material.evaluatorSourceByteLength
    || material.outputContractSha256
      !== validated.material.outputContractSha256
    || material.outputSemanticsSha256
      !== validated.material.outputSemanticsSha256
    || material.isolatedExecutionRequired !== true
    || material.isolatedExecutionVerified !== false
    || material.acceptedForGpuHmr !== false
    || material.gpuHmrSuccess !== false
    || material.canSatisfyRuntimeProof !== false
  ) {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_material_binding_mismatch",
    );
  }
  return validated;
}

function entrypointSource(
  document: MaterialDocument,
  material: GpuMcpOutputEvaluatorMaterial,
  outputContentSha256: string,
  outputByteLength: string,
): string {
  const expectedMaterialHash = jsonStringify(material.materialSha256);
  const expectedMaterialLength = jsonStringify(
    material.materialByteLength,
  );
  const expectedOutputHash = jsonStringify(outputContentSha256);
  const expectedOutputLength = jsonStringify(outputByteLength);
  return [
    "import { createHash } from 'node:crypto';",
    "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
    "const stringify = JSON.stringify.bind(JSON);",
    "const hashBytes = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;",
    `const expectedMaterialHash = ${expectedMaterialHash};`,
    `const expectedMaterialLength = ${expectedMaterialLength};`,
    `const expectedOutputHash = ${expectedOutputHash};`,
    `const expectedOutputLength = ${expectedOutputLength};`,
    `const materialBytes = await readFile(new URL('./${MATERIAL_RELATIVE_PATH}', import.meta.url));`,
    `const sourceOutputBytes = await readFile(new URL('./${OUTPUT_RELATIVE_PATH}', import.meta.url));`,
    "if (hashBytes(materialBytes) !== expectedMaterialHash",
    "  || String(materialBytes.byteLength) !== expectedMaterialLength) {",
    "  throw new Error('evaluator_material_binding_mismatch');",
    "}",
    "if (hashBytes(sourceOutputBytes) !== expectedOutputHash",
    "  || String(sourceOutputBytes.byteLength) !== expectedOutputLength) {",
    "  throw new Error('observed_output_binding_mismatch');",
    "}",
    "const evaluatorInput = new Uint8Array(sourceOutputBytes);",
    "const pristineInput = new Uint8Array(evaluatorInput);",
    "const inputEvery = pristineInput.every.bind(pristineInput);",
    "const evaluatorInputAt = evaluatorInput.at.bind(evaluatorInput);",
    "const controller = new AbortController();",
    "const evaluate = (",
    document.evaluatorSource,
    ");",
    "const verdict = await evaluate(evaluatorInput, controller.signal);",
    "if (verdict !== true && verdict !== false) {",
    "  throw new Error('evaluator_verdict_invalid');",
    "}",
    "if (evaluatorInput.byteLength !== pristineInput.byteLength) {",
    "  throw new Error('evaluator_input_mutated');",
    "}",
    "if (!inputEvery((byte, index) => evaluatorInputAt(index) === byte)) {",
    "  throw new Error('evaluator_input_mutated');",
    "}",
    "const result = {",
    `  schemaVersion: ${jsonStringify(RESULT_SCHEMA)},`,
    "  evaluatorMaterialSha256: expectedMaterialHash,",
    "  evaluatorMaterialByteLength: expectedMaterialLength,",
    "  outputContentSha256: expectedOutputHash,",
    "  outputByteLength: expectedOutputLength,",
    "  outputContractPassed: verdict,",
    "};",
    `await mkdir(new URL('./${path.posix.dirname(RESULT_RELATIVE_PATH)}/', import.meta.url), { recursive: true });`,
    `await writeFile(new URL('./${RESULT_RELATIVE_PATH}', import.meta.url), stringify(result), { flag: 'wx' });`,
    "",
  ].join("\n");
}

function parseResult(
  bytes: Uint8Array,
  material: GpuMcpOutputEvaluatorMaterial,
  outputContentSha256: string,
  outputByteLength: string,
): FreshProcessResult {
  const text = bufferFrom(bytes).toString("utf8");
  let parsed: unknown;
  try {
    parsed = reflectApply(jsonParse, JSON, [text]);
  } catch {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_result_invalid",
    );
  }
  const record = exactPlainRecord(parsed, RESULT_KEYS);
  if (
    record === null
    || reflectApply(jsonStringify, JSON, [record]) !== text
    || record.schemaVersion !== RESULT_SCHEMA
    || record.evaluatorMaterialSha256 !== material.materialSha256
    || record.evaluatorMaterialByteLength !== material.materialByteLength
    || record.outputContentSha256 !== outputContentSha256
    || record.outputByteLength !== outputByteLength
    || (
      record.outputContractPassed !== true
      && record.outputContractPassed !== false
    )
  ) {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_result_invalid",
    );
  }
  return freeze(record) as unknown as FreshProcessResult;
}

function processObservationHash(
  observation: ProcessObservation,
): string {
  const projection = {
    schemaVersion: observation.schemaVersion,
    childPid: observation.childPid,
    startedAt: observation.startedAt,
    finishedAt: observation.finishedAt,
    sessionNonce: observation.sessionNonce,
    invocationHash: observation.prelaunchBinding?.invocationHash ?? null,
    executableHash: observation.prelaunchBinding?.executableHash ?? null,
    requestedEnvironmentHash:
      observation.prelaunchBinding?.requestedEnvironmentHash ?? null,
    executionEnvironmentHash:
      observation.prelaunchBinding?.executionEnvironmentHash ?? null,
    registeredOutputsHash:
      observation.prelaunchBinding?.registeredOutputsHash ?? null,
    spawnedExecutableHash: observation.spawnedExecutableHash,
    executableIdentityStable: observation.executableIdentityStable,
    executionGraphHash: observation.executionGraphHash,
    executionGraphStable: observation.executionGraphStable,
    loadedGraphIdentityAttested:
      observation.loadedGraphIdentityAttested,
    loadedGraphIdentityGap: observation.loadedGraphIdentityGap,
    processChannelCaptured: observation.processChannelCaptured,
    stdoutBytesHash: observation.stdoutBytesHash,
    stdoutByteLength: observation.stdoutByteLength,
    stderrBytesHash: observation.stderrBytesHash,
    stderrByteLength: observation.stderrByteLength,
    parentMonotonicInterval: {
      clockDomain: observation.parentMonotonicInterval.clockDomain,
      startNs: observation.parentMonotonicInterval.startNs,
      endNs: observation.parentMonotonicInterval.endNs,
    },
    resultChannelHash: observation.resultChannelHash,
  };
  const canonical = jsonStringify(projection);
  if (canonical === undefined) {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_observation_invalid",
    );
  }
  return sha256(canonical);
}

async function executeValidatedMaterialInFreshProcess(
  evaluatorMaterial: GpuMcpOutputEvaluatorMaterial,
  document: MaterialDocument,
  materialBytes: Uint8Array,
  observedBytes: Uint8Array,
  executionTimeoutMs: number,
): Promise<GpuMcpOutputEvaluatorFreshProcessExecution> {
  let graph: ControlledExecutionGraph | null = null;
  let trustedRoot: string | null = null;
  let entryBytes: Buffer | null = null;
  let resultReceipt: ControlledResultReceipt | null = null;
  try {
    const outputContentSha256 = sha256(observedBytes);
    const outputByteLength = String(observedBytes.byteLength);
    const entrySource = entrypointSource(
      document,
      evaluatorMaterial,
      outputContentSha256,
      outputByteLength,
    );
    entryBytes = bufferFrom(entrySource, "utf8");
    const entrypointSha256 = sha256(entryBytes);
    const entrypointByteLength = String(entryBytes.byteLength);
    trustedRoot = await mkdtemp(
      path.join(tmpdir(), "synthi-output-evaluator-source-"),
    );
    graph = await coldExecutionAuthority.createControlledExecutionGraph({
      trustedRoot,
      entryRelativePath: ENTRY_RELATIVE_PATH,
      entryBytes,
      moduleEntryPaths: [],
      supportFilePaths: [],
      moduleEntries: [],
      supportEntries: [
        {
          relativePath: MATERIAL_RELATIVE_PATH,
          bytes: bufferFrom(materialBytes),
        },
        {
          relativePath: OUTPUT_RELATIVE_PATH,
          bytes: bufferFrom(observedBytes),
        },
      ],
    });
    const graphEntry = graph.entries.find(
      (entry) => entry.relativePath === ENTRY_RELATIVE_PATH,
    );
    if (
      graphEntry?.contentHash !== entrypointSha256
      || String(graphEntry.byteLength) !== entrypointByteLength
      || await coldExecutionAuthority.verifyControlledExecutionGraph(graph)
        !== true
    ) {
      throw new Error(
        "gpu_mcp_output_evaluator_fresh_process_graph_invalid",
      );
    }
    const entryPath =
      coldExecutionAuthority.controlledExecutionGraphEntryPath(graph);
    const graphRoot =
      coldExecutionAuthority.controlledExecutionGraphRoot(graph);
    const resultPath =
      coldExecutionAuthority.registerControlledExecutionOutput(
        graph,
        path.join(trustedRoot, ...RESULT_RELATIVE_PATH.split("/")),
      );
    if (entryPath === null || graphRoot === null || resultPath === null) {
      throw new Error(
        "gpu_mcp_output_evaluator_fresh_process_graph_invalid",
      );
    }
    const execution = await coldExecutionAuthority.runProcess(
      process.execPath,
      [entryPath],
      {
        cwd: graphRoot,
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
        executionAuthority: {
          kind: "controlled_ecmascript_graph",
          graph,
          entryPath,
        },
        timeoutMs: executionTimeoutMs,
        stdoutMax: MAX_CAPTURED_STREAM_BYTES,
        stderrMax: MAX_CAPTURED_STREAM_BYTES,
        streamOutput: false,
      },
    );
    if (execution.timedOut) {
      throw new Error(
        "gpu_mcp_output_evaluator_fresh_process_timed_out",
      );
    }
    if (execution.stdoutTruncated || execution.stderrTruncated) {
      throw new Error(
        "gpu_mcp_output_evaluator_fresh_process_stream_limit_exceeded",
      );
    }
    if (
      execution.error !== null
      || execution.exitCode !== 0
      || execution.signal !== null
    ) {
      throw new Error(
        "gpu_mcp_output_evaluator_fresh_process_failed",
      );
    }
    resultReceipt =
      await coldExecutionAuthority.readRegisteredGraphResultReceipt({
        executionResult: execution,
        graph,
        resultPath,
      });
    const processObservation =
      coldExecutionAuthority.getProcessExecutionAuthority(execution);
    if (
      resultReceipt === null
      || processObservation === null
      || coldExecutionAuthority.verifyRegisteredGraphResultReceipt(
        execution,
        resultReceipt,
      ) !== true
      || processObservation.executionGraphHash !== graph.graphHash
      || processObservation.executionGraphStable !== true
      || processObservation.processChannelCaptured !== true
      || processObservation.loadedGraphIdentityAttested !== false
      || processObservation.loadedGraphIdentityGap
        !== "runtime_loaded_graph_identity_attestation_missing"
      || await coldExecutionAuthority.verifyControlledExecutionGraph(
        graph,
        { requireOutputs: true },
      ) !== true
    ) {
      throw new Error(
        "gpu_mcp_output_evaluator_fresh_process_result_unverified",
      );
    }
    const result = parseResult(
      resultReceipt.bytes,
      evaluatorMaterial,
      outputContentSha256,
      outputByteLength,
    );
    const content = freeze({
      schemaVersion:
        GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_SCHEMA,
      proofAuthority:
        GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_AUTHORITY,
      evaluatorMaterialSha256: evaluatorMaterial.materialSha256,
      evaluatorMaterialByteLength: evaluatorMaterial.materialByteLength,
      evaluatorFunctionSourceSha256:
        evaluatorMaterial.evaluatorFunctionSourceSha256,
      evaluatorSourceSha256: evaluatorMaterial.evaluatorSourceSha256,
      outputContractSha256: evaluatorMaterial.outputContractSha256,
      outputSemanticsSha256: evaluatorMaterial.outputSemanticsSha256,
      outputContentSha256,
      outputByteLength,
      executionEntrypointSha256: entrypointSha256,
      executionEntrypointByteLength: entrypointByteLength,
      executionGraphHash: graph.graphHash,
      processObservationHash:
        processObservationHash(processObservation),
      resultContentSha256: resultReceipt.resultBytesHash,
      resultByteLength: String(resultReceipt.resultByteLength),
      executionStartedMonotonicNs: execution.startedMonotonicNs,
      executionFinishedMonotonicNs: execution.finishedMonotonicNs,
      timeoutMs: execution.timeoutMs,
      timedOut: false as const,
      exitCode: 0 as const,
      outputContractPassed: result.outputContractPassed,
      freshProcessExecutionObserved: true as const,
      parentClosureUnavailable: true as const,
      staticExecutionGraphVerified: true as const,
      loadedGraphIdentityAttested: false as const,
      loadedGraphIdentityGap:
        "runtime_loaded_graph_identity_attestation_missing" as const,
      isolatedExecutionVerified: false as const,
      containerAttestationVerified: false as const,
      acceptedForGpuHmr: false as const,
      gpuHmrSuccess: false as const,
      canSatisfyRuntimeProof: false as const,
    });
    return content;
  } finally {
    if (resultReceipt !== null) fillBytes(resultReceipt.bytes);
    if (graph !== null) {
      await coldExecutionAuthority.removeControlledExecutionGraph(graph);
    }
    if (trustedRoot !== null) {
      await rm(trustedRoot, { recursive: true, force: true });
    }
    if (entryBytes !== null) fillBytes(entryBytes);
    fillBytes(materialBytes);
    fillBytes(observedBytes);
  }
}

export async function executeReopenedGpuMcpOutputEvaluatorMaterialInFreshProcess(
  executorClaim: GpuMcpOutputEvaluatorExecutorClaim,
  evaluatorCapability: GpuMcpOutputEvaluatorCapability,
  evaluatorMaterialBytesValue: Uint8Array,
  observedBytesValue: Uint8Array,
  optionsValue?: GpuMcpOutputEvaluatorFreshProcessOptions,
): Promise<GpuMcpOutputEvaluatorFreshProcessExecution> {
  if (!gpuMcpOutputEvaluatorCapabilityMatchesExecutorClaim(
    executorClaim,
    evaluatorCapability,
  )) {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_executor_claim_invalid",
    );
  }
  const executionTimeoutMs = timeoutMs(optionsValue);
  const evaluatorMaterial =
    gpuMcpOutputEvaluatorMaterial(evaluatorCapability);
  const materialBytes =
    snapshotValidatedUint8Array(evaluatorMaterialBytesValue);
  const observedBytes =
    snapshotValidatedUint8Array(observedBytesValue);
  if (evaluatorMaterial === null || materialBytes === null) {
    if (materialBytes !== null) fillBytes(materialBytes);
    if (observedBytes !== null) fillBytes(observedBytes);
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_material_unavailable",
    );
  }
  if (observedBytes === null) {
    fillBytes(materialBytes);
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_output_bytes_invalid",
    );
  }
  let validated: ReturnType<typeof validateMaterial>;
  try {
    validated = validateMaterial(evaluatorMaterial, materialBytes);
  } catch (error) {
    fillBytes(materialBytes);
    fillBytes(observedBytes);
    throw error;
  }
  const execution = await executeValidatedMaterialInFreshProcess(
    validated.material,
    validated.document,
    materialBytes,
    observedBytes,
    executionTimeoutMs,
  );
  if (!gpuMcpOutputEvaluatorCapabilityMatchesExecutorClaim(
    executorClaim,
    evaluatorCapability,
  )) {
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_executor_claim_invalid",
    );
  }
  return execution;
}

export async function executeGpuMcpOutputEvaluatorInFreshProcess(
  evaluatorCapability: GpuMcpOutputEvaluatorCapability,
  observedBytesValue: Uint8Array,
  optionsValue?: GpuMcpOutputEvaluatorFreshProcessOptions,
): Promise<GpuMcpOutputEvaluatorFreshProcessExecution> {
  const executionTimeoutMs = timeoutMs(optionsValue);
  const evaluatorMaterial =
    gpuMcpOutputEvaluatorMaterial(evaluatorCapability);
  const materialBytes =
    snapshotGpuMcpOutputEvaluatorMaterialBytes(evaluatorCapability);
  const observedBytes =
    snapshotValidatedUint8Array(observedBytesValue);
  if (evaluatorMaterial === null || materialBytes === null) {
    if (materialBytes !== null) fillBytes(materialBytes);
    if (observedBytes !== null) fillBytes(observedBytes);
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_material_unavailable",
    );
  }
  if (observedBytes === null) {
    fillBytes(materialBytes);
    throw new Error(
      "gpu_mcp_output_evaluator_fresh_process_output_bytes_invalid",
    );
  }
  let validated: ReturnType<typeof validateMaterial>;
  try {
    validated = validateMaterial(evaluatorMaterial, materialBytes);
  } catch (error) {
    fillBytes(materialBytes);
    fillBytes(observedBytes);
    throw error;
  }
  return executeValidatedMaterialInFreshProcess(
    validated.material,
    validated.document,
    materialBytes,
    observedBytes,
    executionTimeoutMs,
  );
}
