import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type {
  RuntimeEvidenceTransportPreparedSupportEnvelope,
  RuntimeEvidenceTransportSupportEnvelopeInput,
  RuntimeEvidenceTransportSupportPreparation,
  RuntimeEvidenceTransportSupportVerification,
} from "./runtime_evidence_transport.js";

const PARENT_VERIFICATION_SCHEMA =
  "synthi.gpu_hmr.parent_verified_runtime_proof.v3";
const PARENT_VERIFICATION_AUTHORITY =
  "parent_recomputed_runtime_proof_binding_only_not_gpu_hmr_acceptance";
const PARENT_SUBJECT_SCHEMA =
  "synthi.gpu_hmr.parent_verified_runtime_proof_subject.v3";
const PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT_SCHEMA =
  "synthi.gpu_hmr.reload_output_oracle_profile_commitment.v1";
const VALIDATION_SCHEMA =
  "synthi.gpu_hmr.parent_runtime_proof_transport_verification.v1";
const PREPARATION_SCHEMA =
  "synthi.gpu_hmr.parent_runtime_proof_transport_preparation.v1";
const PREPARATION_AUTHORITY =
  "parent_runtime_proof_preparation_only_not_gpu_hmr_acceptance";
const PARENT_RECEIPT_PREFIX = "gpu-parent-runtime-proof-receipt:";
const TRANSPORT_RECEIPT_PREFIX =
  "gpu-hmr-runtime-evidence-transport-receipt:sha256:";

// Keep this portable profile identical to the worker-side proof verifier.
const MAX_CANONICAL_DEPTH = 128;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CONTAINER_ENTRIES = 100_000;
const MAX_STRING_UTF8_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_UTF8_BYTES = 16 * 1024 * 1024;
const CANONICAL_CHUNK_UTF8_BYTES = 64 * 1024;
const MAX_PROCESS_ID = 0xffff_ffff;

const PARENT_VERIFICATION_KEYS = [
  "schemaVersion",
  "proofAuthority",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
  "parentRecomputed",
  "runtimeContinuationAcknowledged",
  "compileSessionId",
  "requestId",
  "sourceEditId",
  "artifactContentHash",
  "fullRuntimeProofId",
  "proofLedgerId",
  "protectedProofJsonSha256",
  "canonicalProofSha256",
  "runnerPid",
  "runnerRuntimeSessionId",
  "runnerChallenge",
  "commandEnvelopeSha256",
  "computeExpectedOutputSemanticsHash",
  "prepublicationOutputOracleCommitment",
  "parentPid",
  "runtimeEvidenceTransportEnvelope",
  "receiptId",
] as const;

const EXPECTED_BINDING_KEYS = [
  "requestId",
  "sourceEditId",
  "artifactContentHash",
  "fullRuntimeProofId",
  "proofLedgerId",
  "runnerProcessId",
  "runnerRuntimeSessionId",
  "runnerChallenge",
  "commandEnvelopeSha256",
  "computeExpectedOutputSemanticsHash",
  "prepublicationOutputOracleCommitment",
] as const;

const PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT_KEYS = [
  "schemaVersion",
  "candidateArtifactSha256",
  "fissionOutputOracleContractSha256",
  "profileBytesSha256",
  "editId",
] as const;

export interface GpuParentRuntimeProofReceiptConsumer {
  consumeSupportEnvelope(
    input: RuntimeEvidenceTransportSupportEnvelopeInput,
  ): RuntimeEvidenceTransportSupportVerification;
}

export interface GpuParentRuntimeProofTransactionalReceiptConsumer
extends GpuParentRuntimeProofReceiptConsumer {
  prepareSupportEnvelope(
    input: RuntimeEvidenceTransportSupportEnvelopeInput,
  ): RuntimeEvidenceTransportSupportPreparation;
  commitPreparedSupportEnvelope(
    capability: RuntimeEvidenceTransportPreparedSupportEnvelope,
  ): RuntimeEvidenceTransportSupportVerification;
}

export interface GpuParentRuntimeProofExpectedBinding {
  readonly requestId: string;
  readonly sourceEditId: string;
  readonly artifactContentHash: string;
  readonly fullRuntimeProofId: string;
  readonly proofLedgerId: string;
  readonly runnerProcessId: number;
  readonly runnerRuntimeSessionId: string;
  readonly runnerChallenge: string;
  readonly commandEnvelopeSha256: string;
  readonly computeExpectedOutputSemanticsHash: string | null;
  readonly prepublicationOutputOracleCommitment:
    GpuParentRuntimeOutputOracleCommitment | null;
}

export interface GpuParentRuntimeOutputOracleCommitment {
  readonly schemaVersion: typeof PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT_SCHEMA;
  readonly candidateArtifactSha256: string;
  readonly fissionOutputOracleContractSha256: string;
  readonly profileBytesSha256: string;
  readonly editId: string;
}

export interface GpuParentRuntimeProofVerificationContext {
  readonly transportSessionId: string;
  readonly expectedWorkerProcessId: string;
  readonly expectedBinding: GpuParentRuntimeProofExpectedBinding;
  readonly receiptConsumer: GpuParentRuntimeProofReceiptConsumer;
}

export type GpuParentRuntimeProofTransactionalVerificationContext = Omit<
  GpuParentRuntimeProofVerificationContext,
  "receiptConsumer"
> & {
  readonly receiptConsumer: GpuParentRuntimeProofTransactionalReceiptConsumer;
};

export interface GpuParentRuntimeProofValidationEvidence {
  readonly parentReceiptId: string | null;
  readonly transportReceiptId: string | null;
  readonly canonicalProofSha256: string | null;
  readonly observationContextHash: string | null;
}

export interface GpuParentRuntimeProofValidation {
  readonly schemaVersion: typeof VALIDATION_SCHEMA;
  readonly verified: boolean;
  readonly code: string;
  readonly reason: string | null;
  readonly evidence: GpuParentRuntimeProofValidationEvidence;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuParentRuntimeProofPreparation {
  readonly schemaVersion: typeof PREPARATION_SCHEMA;
  readonly proofAuthority: typeof PREPARATION_AUTHORITY;
  readonly prepared: boolean;
  readonly code: string;
  readonly reason: string | null;
  readonly evidence: GpuParentRuntimeProofValidationEvidence;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

interface PreparedParentRuntimeProofState {
  readonly capability: RuntimeEvidenceTransportPreparedSupportEnvelope;
  readonly commitPreparedSupportEnvelope: (
    capability: RuntimeEvidenceTransportPreparedSupportEnvelope,
  ) => RuntimeEvidenceTransportSupportVerification;
  readonly evidence: GpuParentRuntimeProofValidationEvidence;
}

const preparedParentRuntimeProofStates = new WeakMap<
  GpuParentRuntimeProofPreparation,
  PreparedParentRuntimeProofState
>();
const retiredParentRuntimeProofPreparations = new WeakSet<
  GpuParentRuntimeProofPreparation
>();

const SUPPORT_PREPARATION_KEYS = [
  "schemaVersion",
  "proofAuthority",
  "prepared",
  "reason",
  "capability",
  "receiptId",
  "observationContextHash",
  "freshnessChecked",
  "replayChecked",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;
const SUPPORT_VERIFICATION_KEYS = [
  "verified",
  "reason",
  "receiptId",
  "observationContextHash",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;

interface CanonicalState {
  readonly chunks: string[];
  readonly pendingParts: string[];
  readonly ancestors: WeakSet<object>;
  pendingByteLength: number;
  byteLength: number;
  nodeCount: number;
}

class PortableCanonicalJsonError extends TypeError {}

function failCanonical(message: string): never {
  throw new PortableCanonicalJsonError(message);
}

function flushCanonical(state: CanonicalState): void {
  if (state.pendingParts.length === 0) return;
  state.chunks.push(state.pendingParts.join(""));
  state.pendingParts.length = 0;
  state.pendingByteLength = 0;
}

function appendCanonical(state: CanonicalState, value: string): void {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (state.byteLength + byteLength > MAX_CANONICAL_UTF8_BYTES) {
    failCanonical("canonical JSON exceeds the portable byte limit");
  }
  state.byteLength += byteLength;
  if (byteLength >= CANONICAL_CHUNK_UTF8_BYTES) {
    flushCanonical(state);
    state.chunks.push(value);
    return;
  }
  if (
    state.pendingByteLength + byteLength > CANONICAL_CHUNK_UTF8_BYTES
  ) {
    flushCanonical(state);
  }
  state.pendingParts.push(value);
  state.pendingByteLength += byteLength;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function canonicalString(value: string): string {
  if (
    hasUnpairedSurrogate(value)
    || Buffer.byteLength(value, "utf8") > MAX_STRING_UTF8_BYTES
  ) {
    failCanonical("string is outside the portable canonical JSON profile");
  }
  return JSON.stringify(value);
}

function boundedEnumerableDataEntries(
  value: object,
  maxEntries: number,
): Array<{ key: string; value: unknown }> {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    failCanonical("symbol keys are not portable JSON");
  }
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (entries.length >= maxEntries) {
      failCanonical("container exceeds the portable entry limit");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      failCanonical("accessor or non-enumerable fields are not portable JSON");
    }
    entries.push({ key, value: descriptor.value });
  }
  return entries;
}

function writeCanonical(value: unknown, state: CanonicalState, depth: number): void {
  if (depth > MAX_CANONICAL_DEPTH) {
    failCanonical("canonical JSON exceeds the portable depth limit");
  }
  state.nodeCount += 1;
  if (state.nodeCount > MAX_CANONICAL_NODES) {
    failCanonical("canonical JSON exceeds the portable node limit");
  }
  if (value === null) {
    appendCanonical(state, "null");
    return;
  }
  if (typeof value === "boolean") {
    appendCanonical(state, value ? "true" : "false");
    return;
  }
  if (typeof value === "string") {
    appendCanonical(state, canonicalString(value));
    return;
  }
  if (typeof value === "number") {
    if (
      !Number.isSafeInteger(value)
      || Object.is(value, -0)
    ) {
      failCanonical("number is outside the portable canonical JSON profile");
    }
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string") failCanonical("number is not JSON encodable");
    appendCanonical(state, encoded);
    return;
  }
  if (typeof value !== "object") {
    failCanonical("value is not supported by portable canonical JSON");
  }
  if (state.ancestors.has(value)) failCanonical("cyclic JSON is not supported");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        failCanonical("array is outside the portable canonical JSON profile");
      }
      if (value.length > MAX_CONTAINER_ENTRIES) {
        failCanonical("container exceeds the portable entry limit");
      }
      let enumerableEntryCount = 0;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        enumerableEntryCount += 1;
        if (
          enumerableEntryCount > value.length
          || !/^(0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= value.length
        ) {
          failCanonical("sparse or extended arrays are not portable JSON");
        }
      }
      if (
        enumerableEntryCount !== value.length
        || Object.getOwnPropertySymbols(value).length > 0
      ) {
        failCanonical("sparse or extended arrays are not portable JSON");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined
          || !("value" in descriptor)
          || descriptor.enumerable !== true
        ) {
          failCanonical("sparse or accessor arrays are not portable JSON");
        }
      }
      appendCanonical(state, "[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) appendCanonical(state, ",");
        writeCanonical(value[index], state, depth + 1);
      }
      appendCanonical(state, "]");
      return;
    }

    if (Object.getPrototypeOf(value) !== Object.prototype) {
      failCanonical("non-plain objects are not portable JSON");
    }
    const encodedEntries = boundedEnumerableDataEntries(
      value,
      MAX_CONTAINER_ENTRIES,
    ).map((entry) => ({
      ...entry,
      utf8: Buffer.from(entry.key, "utf8"),
    }));
    for (const entry of encodedEntries) canonicalString(entry.key);
    encodedEntries.sort((left, right) => Buffer.compare(left.utf8, right.utf8));

    appendCanonical(state, "{");
    for (let index = 0; index < encodedEntries.length; index += 1) {
      const entry = encodedEntries[index];
      if (entry === undefined) failCanonical("object key disappeared during encoding");
      if (index > 0) appendCanonical(state, ",");
      appendCanonical(state, canonicalString(entry.key));
      appendCanonical(state, ":");
      writeCanonical(entry.value, state, depth + 1);
    }
    appendCanonical(state, "}");
  } finally {
    state.ancestors.delete(value);
  }
}

/** Matches the worker's recursive stable_json profile for portable JSON values. */
export function canonicalizeGpuParentRuntimeProofJson(value: unknown): string {
  const state: CanonicalState = {
    chunks: [],
    pendingParts: [],
    ancestors: new WeakSet<object>(),
    pendingByteLength: 0,
    byteLength: 0,
    nodeCount: 0,
  };
  writeCanonical(value, state, 0);
  flushCanonical(state);
  return state.chunks.join("");
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  try {
    boundedEnumerableDataEntries(value, MAX_CONTAINER_ENTRIES);
  } catch {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  let entries: Array<{ key: string; value: unknown }>;
  try {
    entries = boundedEnumerableDataEntries(value, expected.length + 1);
  } catch {
    return false;
  }
  return entries.length === expected.length
    && expected.every((key) => entries.some((entry) => entry.key === key));
}

function canonicalToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[\x21-\x7e]+$/.test(value);
}

function canonicalSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function canonicalPrefixedSha256(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && value.startsWith(prefix)
    && canonicalSha256(value.slice(prefix.length));
}

function canonicalProcessNumber(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_PROCESS_ID;
}

function normalizeExternalProcessId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(MAX_PROCESS_ID) ? value : null;
  } catch {
    return null;
  }
}

function omitKey(
  value: Record<string, unknown>,
  omittedKey: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key !== omittedKey) result[key] = value[key];
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function captureCallableMethod(
  receiver: unknown,
  key: string,
): ((argument: unknown) => unknown) | null {
  try {
    if (
      receiver === null
      || typeof receiver !== "object"
      || Array.isArray(receiver)
      || isProxy(receiver)
    ) {
      return null;
    }
    let owner: object | null = receiver;
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      if (isProxy(owner)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor !== undefined) {
        if (
          !("value" in descriptor)
          || typeof descriptor.value !== "function"
          || isProxy(descriptor.value)
        ) {
          return null;
        }
        const method = descriptor.value;
        return (argument) => Reflect.apply(method, receiver, [argument]);
      }
      owner = Object.getPrototypeOf(owner);
    }
    return null;
  } catch {
    return null;
  }
}

function snapshotSupportVerification(
  value: unknown,
): RuntimeEvidenceTransportSupportVerification | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || !hasExactKeys(value as Record<string, unknown>, SUPPORT_VERIFICATION_KEYS)
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of SUPPORT_VERIFICATION_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !("value" in descriptor)
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    if (
      typeof snapshot.verified !== "boolean"
      || !(snapshot.reason === null || typeof snapshot.reason === "string")
      || !(snapshot.receiptId === null || typeof snapshot.receiptId === "string")
      || !(
        snapshot.observationContextHash === null
        || typeof snapshot.observationContextHash === "string"
      )
      || snapshot.acceptedForGpuHmr !== false
      || snapshot.gpuHmrSuccess !== false
      || snapshot.canSatisfyRuntimeProof !== false
    ) {
      return null;
    }
    return Object.freeze(snapshot) as unknown as
      RuntimeEvidenceTransportSupportVerification;
  } catch {
    return null;
  }
}

function snapshotSupportPreparation(
  value: unknown,
): RuntimeEvidenceTransportSupportPreparation | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || !hasExactKeys(value as Record<string, unknown>, SUPPORT_PREPARATION_KEYS)
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of SUPPORT_PREPARATION_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !("value" in descriptor)
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    const capability = snapshot.capability;
    if (
      snapshot.schemaVersion
        !== "synthi.gpu_hmr.runtime_evidence_transport_preparation.v1"
      || snapshot.proofAuthority
        !== "cryptographic_and_freshness_preparation_only_replay_not_committed"
      || typeof snapshot.prepared !== "boolean"
      || !(snapshot.reason === null || typeof snapshot.reason === "string")
      || !(
        capability === null
        || (typeof capability === "object" && !Array.isArray(capability))
      )
      || !(snapshot.receiptId === null || typeof snapshot.receiptId === "string")
      || !(
        snapshot.observationContextHash === null
        || typeof snapshot.observationContextHash === "string"
      )
      || typeof snapshot.freshnessChecked !== "boolean"
      || snapshot.replayChecked !== false
      || snapshot.acceptedForGpuHmr !== false
      || snapshot.gpuHmrSuccess !== false
      || snapshot.canSatisfyRuntimeProof !== false
      || (snapshot.prepared === true && (
        capability === null
        || snapshot.reason !== null
        || typeof snapshot.receiptId !== "string"
        || !snapshot.receiptId.startsWith(TRANSPORT_RECEIPT_PREFIX)
        || !canonicalSha256(snapshot.receiptId.slice(
          "gpu-hmr-runtime-evidence-transport-receipt:".length,
        ))
        || !canonicalSha256(snapshot.observationContextHash)
        || snapshot.freshnessChecked !== true
      ))
    ) {
      return null;
    }
    return Object.freeze(snapshot) as unknown as
      RuntimeEvidenceTransportSupportPreparation;
  } catch {
    return null;
  }
}

function validation(
  verified: boolean,
  code: string,
  evidence: GpuParentRuntimeProofValidationEvidence = {
    parentReceiptId: null,
    transportReceiptId: null,
    canonicalProofSha256: null,
    observationContextHash: null,
  },
): GpuParentRuntimeProofValidation {
  return deepFreeze({
    schemaVersion: VALIDATION_SCHEMA,
    verified,
    code,
    reason: verified ? null : code,
    evidence: { ...evidence },
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function preparation(
  prepared: boolean,
  code: string,
  evidence: GpuParentRuntimeProofValidationEvidence = {
    parentReceiptId: null,
    transportReceiptId: null,
    canonicalProofSha256: null,
    observationContextHash: null,
  },
): GpuParentRuntimeProofPreparation {
  return deepFreeze({
    schemaVersion: PREPARATION_SCHEMA,
    proofAuthority: PREPARATION_AUTHORITY,
    prepared,
    code,
    reason: prepared ? null : code,
    evidence: { ...evidence },
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

export function parseGpuParentRuntimeOutputOracleCommitment(
  value: unknown,
): GpuParentRuntimeOutputOracleCommitment | null | undefined {
  if (value === null) return null;
  const commitment = plainRecord(value);
  if (
    commitment === null
    || !hasExactKeys(
      commitment,
      PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT_KEYS,
    )
    || commitment.schemaVersion
      !== PREPUBLICATION_OUTPUT_ORACLE_COMMITMENT_SCHEMA
    || !canonicalSha256(commitment.candidateArtifactSha256)
    || !canonicalSha256(commitment.fissionOutputOracleContractSha256)
    || !canonicalSha256(commitment.profileBytesSha256)
    || !canonicalPrefixedSha256(commitment.editId, "source-edit:")
  ) {
    return undefined;
  }
  return commitment as unknown as GpuParentRuntimeOutputOracleCommitment;
}

function outputOracleCommitmentsMatch(
  left: GpuParentRuntimeOutputOracleCommitment | null,
  right: GpuParentRuntimeOutputOracleCommitment | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.schemaVersion === right.schemaVersion
    && left.candidateArtifactSha256 === right.candidateArtifactSha256
    && left.fissionOutputOracleContractSha256
      === right.fissionOutputOracleContractSha256
    && left.profileBytesSha256 === right.profileBytesSha256
    && left.editId === right.editId;
}

function validParentFieldShapes(parent: Record<string, unknown>): boolean {
  const commitment = parseGpuParentRuntimeOutputOracleCommitment(
    parent.prepublicationOutputOracleCommitment,
  );
  return commitment !== undefined
    && (commitment === null || (
      commitment.candidateArtifactSha256 === parent.artifactContentHash
      && commitment.editId === parent.sourceEditId
    ))
    && canonicalToken(parent.compileSessionId)
    && typeof parent.requestId === "string"
    && /^gpu-reload:request:[a-f0-9]{32}$/.test(parent.requestId)
    && canonicalPrefixedSha256(parent.sourceEditId, "source-edit:")
    && canonicalSha256(parent.artifactContentHash)
    && canonicalPrefixedSha256(parent.fullRuntimeProofId, "gpu-runtime-proof:")
    && canonicalPrefixedSha256(parent.proofLedgerId, "gpu-ledger-proof:")
    && canonicalSha256(parent.protectedProofJsonSha256)
    && canonicalSha256(parent.canonicalProofSha256)
    && canonicalProcessNumber(parent.runnerPid)
    && canonicalToken(parent.runnerRuntimeSessionId)
    && typeof parent.runnerChallenge === "string"
    && /^[a-f0-9]{32}$/.test(parent.runnerChallenge)
    && canonicalSha256(parent.commandEnvelopeSha256)
    && (
      parent.computeExpectedOutputSemanticsHash === null
      || canonicalSha256(parent.computeExpectedOutputSemanticsHash)
    )
    && canonicalProcessNumber(parent.parentPid)
    && typeof parent.receiptId === "string"
    && /^gpu-parent-runtime-proof-receipt:sha256:[a-f0-9]{64}$/.test(parent.receiptId);
}

function validExpectedBinding(
  value: unknown,
): value is GpuParentRuntimeProofExpectedBinding {
  const binding = plainRecord(value);
  const commitment = parseGpuParentRuntimeOutputOracleCommitment(
    binding?.prepublicationOutputOracleCommitment,
  );
  return binding !== null
    && commitment !== undefined
    && (commitment === null || (
      commitment.candidateArtifactSha256 === binding.artifactContentHash
      && commitment.editId === binding.sourceEditId
    ))
    && hasExactKeys(binding, EXPECTED_BINDING_KEYS)
    && typeof binding.requestId === "string"
    && /^gpu-reload:request:[a-f0-9]{32}$/.test(binding.requestId)
    && canonicalPrefixedSha256(binding.sourceEditId, "source-edit:")
    && canonicalSha256(binding.artifactContentHash)
    && canonicalPrefixedSha256(binding.fullRuntimeProofId, "gpu-runtime-proof:")
    && canonicalPrefixedSha256(binding.proofLedgerId, "gpu-ledger-proof:")
    && canonicalProcessNumber(binding.runnerProcessId)
    && canonicalToken(binding.runnerRuntimeSessionId)
    && typeof binding.runnerChallenge === "string"
    && /^[a-f0-9]{32}$/.test(binding.runnerChallenge)
    && canonicalSha256(binding.commandEnvelopeSha256)
    && (
      binding.computeExpectedOutputSemanticsHash === null
      || canonicalSha256(binding.computeExpectedOutputSemanticsHash)
    );
}

function parentMatchesExpectedBinding(
  parent: Record<string, unknown>,
  expected: GpuParentRuntimeProofExpectedBinding,
): boolean {
  const parentCommitment = parseGpuParentRuntimeOutputOracleCommitment(
    parent.prepublicationOutputOracleCommitment,
  );
  return parent.requestId === expected.requestId
    && parent.sourceEditId === expected.sourceEditId
    && parent.artifactContentHash === expected.artifactContentHash
    && parent.fullRuntimeProofId === expected.fullRuntimeProofId
    && parent.proofLedgerId === expected.proofLedgerId
    && parent.runnerPid === expected.runnerProcessId
    && parent.runnerRuntimeSessionId === expected.runnerRuntimeSessionId
    && parent.runnerChallenge === expected.runnerChallenge
    && parent.commandEnvelopeSha256 === expected.commandEnvelopeSha256
    && parent.computeExpectedOutputSemanticsHash
      === expected.computeExpectedOutputSemanticsHash
    && parentCommitment !== undefined
    && outputOracleCommitmentsMatch(
      parentCommitment,
      expected.prepublicationOutputOracleCommitment,
    );
}

export function verifyGpuParentRuntimeProofTransport(
  rawProof: unknown,
  context: GpuParentRuntimeProofVerificationContext,
): GpuParentRuntimeProofValidation {
  if (context === null || typeof context !== "object") {
    return validation(false, "gpu_parent_runtime_proof_external_context_invalid");
  }
  const expectedWorkerProcessId = normalizeExternalProcessId(
    context.expectedWorkerProcessId,
  );
  if (
    !canonicalToken(context.transportSessionId)
    || expectedWorkerProcessId === null
    || !validExpectedBinding(context.expectedBinding)
    || context.receiptConsumer === null
    || typeof context.receiptConsumer !== "object"
    || typeof context.receiptConsumer.consumeSupportEnvelope !== "function"
  ) {
    return validation(false, "gpu_parent_runtime_proof_external_context_invalid");
  }

  const proof = plainRecord(rawProof);
  if (proof === null) {
    return validation(false, "gpu_parent_runtime_proof_object_invalid");
  }
  if (hasOwn(proof, "parent_verification")) {
    return validation(false, "gpu_parent_runtime_proof_parent_alias_rejected");
  }
  if (!hasOwn(proof, "parentVerification")) {
    return validation(false, "gpu_parent_runtime_proof_parent_verification_missing");
  }

  const parent = plainRecord(proof.parentVerification);
  if (parent === null || !hasExactKeys(parent, PARENT_VERIFICATION_KEYS)) {
    return validation(false, "gpu_parent_runtime_proof_parent_shape_invalid");
  }
  if (
    parent.schemaVersion !== PARENT_VERIFICATION_SCHEMA
    || parent.proofAuthority !== PARENT_VERIFICATION_AUTHORITY
    || parent.acceptedForGpuHmr !== false
    || parent.gpuHmrSuccess !== false
    || parent.canSatisfyRuntimeProof !== false
    || parent.parentRecomputed !== true
    || parent.runtimeContinuationAcknowledged !== true
  ) {
    return validation(false, "gpu_parent_runtime_proof_parent_authority_invalid");
  }
  if (!validParentFieldShapes(parent)) {
    return validation(false, "gpu_parent_runtime_proof_parent_field_invalid");
  }
  if (parent.compileSessionId !== context.transportSessionId) {
    return validation(false, "gpu_parent_runtime_proof_transport_session_mismatch");
  }
  if (String(parent.parentPid) !== expectedWorkerProcessId) {
    return validation(false, "gpu_parent_runtime_proof_worker_process_mismatch");
  }
  if (!parentMatchesExpectedBinding(parent, context.expectedBinding)) {
    return validation(false, "gpu_parent_runtime_proof_external_binding_mismatch");
  }

  let canonicalProofBytes: Buffer;
  let canonicalProofSha256: string;
  try {
    const proofWithoutParent = omitKey(proof, "parentVerification");
    canonicalProofBytes = Buffer.from(
      canonicalizeGpuParentRuntimeProofJson(proofWithoutParent),
      "utf8",
    );
    canonicalProofSha256 = sha256(canonicalProofBytes);
  } catch {
    return validation(false, "gpu_parent_runtime_proof_canonicalization_failed");
  }
  if (parent.canonicalProofSha256 !== canonicalProofSha256) {
    return validation(false, "gpu_parent_runtime_proof_canonical_hash_mismatch");
  }

  let expectedParentReceiptId: string;
  try {
    const canonicalParent = canonicalizeGpuParentRuntimeProofJson(
      omitKey(parent, "receiptId"),
    );
    expectedParentReceiptId = `${PARENT_RECEIPT_PREFIX}${sha256(canonicalParent)}`;
  } catch {
    return validation(false, "gpu_parent_runtime_proof_parent_canonicalization_failed");
  }
  if (parent.receiptId !== expectedParentReceiptId) {
    return validation(false, "gpu_parent_runtime_proof_parent_receipt_mismatch");
  }

  let subjectCanonicalBytes: Buffer;
  try {
    subjectCanonicalBytes = Buffer.from(canonicalizeGpuParentRuntimeProofJson([
      PARENT_SUBJECT_SCHEMA,
      parent.compileSessionId,
      parent.requestId,
      parent.sourceEditId,
      parent.artifactContentHash,
      parent.fullRuntimeProofId,
      parent.proofLedgerId,
      parent.protectedProofJsonSha256,
      parent.canonicalProofSha256,
      parent.runnerPid,
      parent.runnerRuntimeSessionId,
      parent.runnerChallenge,
      parent.commandEnvelopeSha256,
      parent.computeExpectedOutputSemanticsHash,
      parent.prepublicationOutputOracleCommitment,
      parent.parentPid,
      true,
    ]), "utf8");
  } catch {
    return validation(false, "gpu_parent_runtime_proof_subject_invalid");
  }

  let receiptVerification: RuntimeEvidenceTransportSupportVerification;
  try {
    receiptVerification = context.receiptConsumer.consumeSupportEnvelope({
      envelope: parent.runtimeEvidenceTransportEnvelope,
      observedPayload: canonicalProofBytes,
      runnerProcessId: parent.runnerPid as number,
      runtimeSessionId: parent.runnerRuntimeSessionId as string,
      runnerChallenge: parent.runnerChallenge as string,
      transportSessionId: context.transportSessionId,
      requestId: parent.requestId as string,
      sourceEditId: parent.sourceEditId as string,
      subjectIdentityNamespace: PARENT_SUBJECT_SCHEMA,
      subjectCanonicalBytes,
      artifactContentHash: parent.artifactContentHash as string,
      observedRuntimeProofId: parent.fullRuntimeProofId as string,
      observedProofLedgerId: parent.proofLedgerId as string,
    });
  } catch {
    return validation(false, "gpu_parent_runtime_proof_receipt_consumer_failed");
  }

  if (
    receiptVerification.verified !== true
    || receiptVerification.acceptedForGpuHmr !== false
    || receiptVerification.gpuHmrSuccess !== false
    || receiptVerification.canSatisfyRuntimeProof !== false
  ) {
    return validation(false, "gpu_parent_runtime_proof_receipt_consumer_refused");
  }
  if (
    typeof receiptVerification.receiptId !== "string"
    || !receiptVerification.receiptId.startsWith(TRANSPORT_RECEIPT_PREFIX)
    || !canonicalSha256(receiptVerification.receiptId.slice(
      "gpu-hmr-runtime-evidence-transport-receipt:".length,
    ))
    || !canonicalSha256(receiptVerification.observationContextHash)
  ) {
    return validation(false, "gpu_parent_runtime_proof_receipt_result_invalid");
  }

  return validation(true, "gpu_parent_runtime_proof_verified", {
    parentReceiptId: expectedParentReceiptId,
    transportReceiptId: receiptVerification.receiptId,
    canonicalProofSha256,
    observationContextHash: receiptVerification.observationContextHash,
  });
}

export function prepareGpuParentRuntimeProofTransport(
  rawProof: unknown,
  context: GpuParentRuntimeProofTransactionalVerificationContext,
): GpuParentRuntimeProofPreparation {
  const prepareSupportEnvelope = captureCallableMethod(
    context?.receiptConsumer,
    "prepareSupportEnvelope",
  );
  const commitPreparedSupportEnvelope = captureCallableMethod(
    context?.receiptConsumer,
    "commitPreparedSupportEnvelope",
  );
  if (
    prepareSupportEnvelope === null
    || commitPreparedSupportEnvelope === null
  ) {
    return preparation(
      false,
      "gpu_parent_runtime_proof_transactional_context_invalid",
    );
  }

  let capturedPreparation: RuntimeEvidenceTransportSupportPreparation | null = null;
  let preparationCallCount = 0;
  const preparedValidation = verifyGpuParentRuntimeProofTransport(rawProof, {
    transportSessionId: context.transportSessionId,
    expectedWorkerProcessId: context.expectedWorkerProcessId,
    expectedBinding: context.expectedBinding,
    receiptConsumer: {
      consumeSupportEnvelope(input) {
        preparationCallCount += 1;
        if (preparationCallCount !== 1) {
          throw new Error("gpu_parent_runtime_proof_transport_prepare_reentered");
        }
        const candidate = snapshotSupportPreparation(
          prepareSupportEnvelope(input),
        );
        if (candidate === null) {
          throw new Error("gpu_parent_runtime_proof_transport_preparation_invalid");
        }
        capturedPreparation = candidate;
        if (!candidate.prepared || candidate.capability === null) {
          return deepFreeze({
            verified: false,
            reason: candidate.reason
              ?? "runtime_evidence_transport_preparation_failed",
            receiptId: null,
            observationContextHash: null,
            acceptedForGpuHmr: false,
            gpuHmrSuccess: false,
            canSatisfyRuntimeProof: false,
          });
        }
        return deepFreeze({
          verified: true,
          reason: null,
          receiptId: candidate.receiptId,
          observationContextHash: candidate.observationContextHash,
          acceptedForGpuHmr: false,
          gpuHmrSuccess: false,
          canSatisfyRuntimeProof: false,
        });
      },
    },
  });
  if (!preparedValidation.verified) {
    return preparation(
      false,
      preparedValidation.code,
      preparedValidation.evidence,
    );
  }
  const preparedTransport = capturedPreparation as
    RuntimeEvidenceTransportSupportPreparation | null;
  if (preparedTransport?.capability === null || preparedTransport === null) {
    return preparation(
      false,
      "gpu_parent_runtime_proof_transport_prepared_capability_missing",
      preparedValidation.evidence,
    );
  }

  const result = preparation(
    true,
    "gpu_parent_runtime_proof_prepared",
    preparedValidation.evidence,
  );
  preparedParentRuntimeProofStates.set(result, Object.freeze({
    capability: preparedTransport.capability,
    commitPreparedSupportEnvelope: (
      capability: RuntimeEvidenceTransportPreparedSupportEnvelope,
    ) => {
      const rawVerification = commitPreparedSupportEnvelope(capability);
      const verification = snapshotSupportVerification(rawVerification);
      if (verification === null) {
        throw new Error("gpu_parent_runtime_proof_receipt_result_invalid");
      }
      return verification;
    },
    evidence: preparedValidation.evidence,
  }));
  return result;
}

export function commitPreparedGpuParentRuntimeProofTransport(
  preparedProof: unknown,
): GpuParentRuntimeProofValidation {
  if (preparedProof === null || typeof preparedProof !== "object") {
    return validation(
      false,
      "gpu_parent_runtime_proof_preparation_invalid",
    );
  }
  const preparationObject = preparedProof as GpuParentRuntimeProofPreparation;
  if (retiredParentRuntimeProofPreparations.has(preparationObject)) {
    return validation(
      false,
      "gpu_parent_runtime_proof_preparation_already_used",
    );
  }
  const state = preparedParentRuntimeProofStates.get(preparationObject);
  if (state === undefined) {
    return validation(
      false,
      "gpu_parent_runtime_proof_preparation_invalid",
    );
  }
  preparedParentRuntimeProofStates.delete(preparationObject);
  retiredParentRuntimeProofPreparations.add(preparationObject);

  let receiptVerification: RuntimeEvidenceTransportSupportVerification;
  try {
    receiptVerification = state.commitPreparedSupportEnvelope(state.capability);
  } catch {
    return validation(
      false,
      "gpu_parent_runtime_proof_receipt_consumer_failed",
    );
  }
  if (
    receiptVerification.verified !== true
    || receiptVerification.acceptedForGpuHmr !== false
    || receiptVerification.gpuHmrSuccess !== false
    || receiptVerification.canSatisfyRuntimeProof !== false
  ) {
    return validation(
      false,
      "gpu_parent_runtime_proof_receipt_consumer_refused",
    );
  }
  if (
    typeof receiptVerification.receiptId !== "string"
    || !receiptVerification.receiptId.startsWith(TRANSPORT_RECEIPT_PREFIX)
    || !canonicalSha256(receiptVerification.receiptId.slice(
      "gpu-hmr-runtime-evidence-transport-receipt:".length,
    ))
    || !canonicalSha256(receiptVerification.observationContextHash)
  ) {
    return validation(
      false,
      "gpu_parent_runtime_proof_receipt_result_invalid",
    );
  }
  if (
    receiptVerification.receiptId !== state.evidence.transportReceiptId
    || receiptVerification.observationContextHash
      !== state.evidence.observationContextHash
  ) {
    return validation(
      false,
      "gpu_parent_runtime_proof_prepared_receipt_evidence_changed",
    );
  }
  return validation(
    true,
    "gpu_parent_runtime_proof_verified",
    state.evidence,
  );
}
