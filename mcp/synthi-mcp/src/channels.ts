import type { RTCDataChannel } from "werift";
import {
  validateComputeExpectedOutputSemantics,
  type ComputeExpectedOutputSemantics,
} from "./compute_expected_output_semantics.js";
import { HmrNormalizer } from "./hmr.js";
import {
  SessionGpuParentRuntimeProofAdmission,
  type GpuParentRuntimeProofAdmissionSnapshot,
} from "./gpu_parent_runtime_proof_admission.js";
import {
  RuntimeEvidenceTransportReceiptConsumer,
  SessionRuntimeEvidenceTransportReplayStore,
  type RuntimeEvidenceTransportKeyPin,
} from "./runtime_evidence_transport.js";
import { sendFrames, type SendOptions } from "./wire/input.js";
import { randomUUID } from "node:crypto";

const DEFAULT_COMPILE_CHUNK_BYTES = 48_000;
const GPU_PROOF_KEY_PIN_WAIT_MS = 4_000;
const CANONICAL_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GPU_FULL_RUNTIME_PROOF_STATE = "gpu-hmr-full-runtime-proven";
const GPU_TYPED_PROOF_MESSAGE = "gpu_hmr_proof";

function strictParentRuntimeProofId(
  message: Record<string, unknown>,
): string | null {
  if (message.type !== GPU_TYPED_PROOF_MESSAGE) return null;
  if (
    (message.resultState ?? message.result_state)
    !== GPU_FULL_RUNTIME_PROOF_STATE
  ) {
    return null;
  }
  const parent = message.parentVerification;
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
    return null;
  }
  const fullRuntimeProofId = (parent as Record<string, unknown>)
    .fullRuntimeProofId;
  return typeof fullRuntimeProofId === "string" ? fullRuntimeProofId : null;
}

export interface SessionChannelsRuntimeEvidenceContext {
  readonly keyPin: RuntimeEvidenceTransportKeyPin;
  readonly transportSessionId: string;
}

export interface CompileDispatchReceipt {
  readonly schemaVersion: "synthi.gpu_hmr.compile_dispatch_correlation.v1";
  readonly proofAuthority: "compile_dispatch_correlation_only_not_gpu_hmr_acceptance";
  readonly dispatchedAt: number;
  readonly proofCorrelationId: string;
  readonly computeExpectedOutputSemanticsHash: string | null;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

function compileDispatchReceipt(
  dispatchedAt: number,
  proofCorrelationId: string,
  computeExpectedOutputSemanticsHash: string | null,
): CompileDispatchReceipt {
  return Object.freeze({
    schemaVersion: "synthi.gpu_hmr.compile_dispatch_correlation.v1",
    proofAuthority: "compile_dispatch_correlation_only_not_gpu_hmr_acceptance",
    dispatchedAt,
    proofCorrelationId,
    computeExpectedOutputSemanticsHash,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function compileChunkMaxBytes(): number {
  const raw = process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_COMPILE_CHUNK_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`invalid_compile_chunk_bytes:${raw}`);
  }
  return Math.floor(parsed);
}

function serializedChunkBytes(
  chunkId: string,
  seq: number,
  total: number,
  data: string,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      type: "compile-request-chunk",
      chunk_id: chunkId,
      seq,
      total,
      encoding: "base64",
      data,
    }),
    "utf8",
  );
}

function chunkDataCharsForLimit(
  encodedLength: number,
  chunkId: string,
  maxBytes: number,
): {
  chunkChars: number;
  total: number;
} {
  let total = 1;
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const overheadBytes = serializedChunkBytes(
      chunkId,
      Math.max(0, total - 1),
      total,
      "",
    );
    const chunkChars = maxBytes - overheadBytes;
    if (chunkChars < 1) {
      throw new Error(`compile_chunk_bytes_too_small:${maxBytes}`);
    }
    const nextTotal = Math.ceil(encodedLength / chunkChars);
    if (nextTotal === total) {
      return { chunkChars, total };
    }
    total = nextTotal;
  }
  throw new Error(`compile_chunk_bytes_unstable:${maxBytes}`);
}

/**
 * Thin wrapper around a session's data channels.
 *
 * - `build-log` (worker-created, arrives via `ondatachannel` on the MCP PC):
 *   wrapped by HmrNormalizer for terminal-event detection.
 * - `terminal` (MCP-created, outgoing): used for `gui-event` input frames.
 * - `compile` (MCP-created, outgoing): used by `synthi_compile` for
 *   CompileRequest payloads. Worker replies (status / events) flow back on
 *   `build-log`, which the HMR normalizer already consumes.
 *
 * Ordering note (matches `compilerClient.js:905-915`): the MCP creates
 * `terminal` and `compile` before the offer is sent; `build-log` arrives
 * later as part of the worker's SDP answer processing. All three are open
 * before `synthi_attach` resolves.
 */
export class SessionChannels {
  readonly hmr: HmrNormalizer;
  private readonly runtimeEvidenceReplayStore: SessionRuntimeEvidenceTransportReplayStore;
  private readonly runtimeEvidenceReceiptConsumer: RuntimeEvidenceTransportReceiptConsumer;
  private readonly runtimeEvidenceKeyPin: RuntimeEvidenceTransportKeyPin;
  private readonly gpuParentRuntimeProofAdmission: SessionGpuParentRuntimeProofAdmission;
  private runtimeEvidenceKeyPinUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly terminalDC: RTCDataChannel,
    buildLogDC: RTCDataChannel,
    private readonly compileDC: RTCDataChannel,
    runtimeEvidenceContext: SessionChannelsRuntimeEvidenceContext,
  ) {
    this.runtimeEvidenceKeyPin = runtimeEvidenceContext.keyPin;
    this.runtimeEvidenceReplayStore = new SessionRuntimeEvidenceTransportReplayStore();
    this.runtimeEvidenceReceiptConsumer = new RuntimeEvidenceTransportReceiptConsumer(
      runtimeEvidenceContext.keyPin,
      this.runtimeEvidenceReplayStore,
    );
    this.gpuParentRuntimeProofAdmission = new SessionGpuParentRuntimeProofAdmission({
      transportSessionId: runtimeEvidenceContext.transportSessionId,
      keyPin: runtimeEvidenceContext.keyPin,
      receiptConsumer: this.runtimeEvidenceReceiptConsumer,
    });
    this.hmr = new HmrNormalizer(buildLogDC, {
      beforeClassify: (message, observedAt) => {
        const include = this.gpuParentRuntimeProofAdmission.beforeClassify(
          message,
          observedAt,
        );
        if (!include) return false;

        const fullRuntimeProofId = strictParentRuntimeProofId(message);
        if (fullRuntimeProofId === null) return true;
        const parentControlVerificationMaterial =
          this.gpuParentRuntimeProofAdmission
            .takeControlVerificationMaterial(fullRuntimeProofId);
        return parentControlVerificationMaterial === null
          ? false
          : {
              include: true,
              parentControlVerificationMaterial,
            };
      },
    });
    this.runtimeEvidenceKeyPinUnsubscribe = runtimeEvidenceContext.keyPin.onChange(
      (snapshot) => {
        if (snapshot.status === "failed") {
          this.gpuParentRuntimeProofAdmission.invalidateTrust(
            "runtime_evidence_transport_failed",
          );
          this.hmr.invalidateGpuProofTrust("runtime_evidence_transport_failed");
        } else if (snapshot.status === "disposed") {
          this.gpuParentRuntimeProofAdmission.invalidateTrust(
            "runtime_evidence_transport_disposed",
          );
          this.hmr.invalidateGpuProofTrust("runtime_evidence_transport_disposed");
        }
      },
    );
  }

  async sendInput(frames: string[], opts?: SendOptions): Promise<void> {
    return sendFrames(this.terminalDC, frames, opts);
  }

  async requestInputLease(payload: Record<string, unknown>, timeoutMs: number = 4_000): Promise<Record<string, unknown>> {
    if (this.terminalDC.readyState !== "open") {
      throw new Error(`terminal_dc_not_open (state=${this.terminalDC.readyState})`);
    }
    const requestId = typeof payload["request_id"] === "string" && payload["request_id"].length > 0
      ? payload["request_id"]
      : `lease_req_${randomUUID()}`;
    const request = { ...payload, type: "input-lease", request_id: requestId };
    const waiter = new Promise<Record<string, unknown>>((resolve, reject) => {
      let unsub = (): void => {};
      const timer = setTimeout(() => {
        unsub();
        reject(new Error("input_lease_response_timeout"));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      unsub = this.hmr.onMessage((msg) => {
        if (msg["type"] !== "input-lease-result") return;
        if (msg["request_id"] !== requestId) return;
        clearTimeout(timer);
        unsub();
        resolve(msg);
      });
    });
    this.terminalDC.send(JSON.stringify(request));
    return waiter;
  }

  /**
   * Send a compile request with an MCP-issued, one-shot proof correlation.
   * The returned receipt is transport metadata only; runtime proof must still
   * pass parent-bound admission before HMR classification can accept it.
   */
  async sendCompileRequest(
    payload: Record<string, unknown>,
    computeExpectedOutputContractHash?: string,
    computeExpectedOutputSemantics?: ComputeExpectedOutputSemantics,
  ): Promise<CompileDispatchReceipt> {
    if (this.compileDC.readyState !== "open") {
      throw new Error(`compile_channel_not_open:${this.compileDC.readyState}`);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "gpu_proof_transport_nonce")) {
      throw new Error("compile_gpu_proof_transport_nonce_reserved");
    }
    if (
      Object.prototype.hasOwnProperty.call(payload, "compute_expected_output_contract_hash")
      || Object.prototype.hasOwnProperty.call(payload, "computeExpectedOutputContractHash")
    ) {
      throw new Error("compile_compute_expected_output_contract_hash_reserved");
    }
    if (
      Object.prototype.hasOwnProperty.call(payload, "compute_expected_output_semantics")
      || Object.prototype.hasOwnProperty.call(payload, "computeExpectedOutputSemantics")
      || Object.prototype.hasOwnProperty.call(payload, "compute_expected_output_semantics_hash")
      || Object.prototype.hasOwnProperty.call(payload, "computeExpectedOutputSemanticsHash")
    ) {
      throw new Error("compile_compute_expected_output_semantics_reserved");
    }
    const capturedExpectedOutputContractHash = computeExpectedOutputContractHash;
    if (
      capturedExpectedOutputContractHash !== undefined
      && !CANONICAL_SHA256_PATTERN.test(capturedExpectedOutputContractHash)
    ) {
      throw new Error("compile_compute_expected_output_contract_hash_invalid");
    }
    const semanticsValidation = computeExpectedOutputSemantics === undefined
      ? null
      : validateComputeExpectedOutputSemantics(computeExpectedOutputSemantics);
    if (semanticsValidation !== null && !semanticsValidation.accepted) {
      throw new Error(
        `compile_compute_expected_output_semantics_invalid:${semanticsValidation.reason}`,
      );
    }
    const capturedExpectedOutputSemantics = semanticsValidation?.accepted === true
      ? semanticsValidation.value
      : null;
    const capturedPayload = { ...payload };
    if (Object.prototype.hasOwnProperty.call(capturedPayload, "gpu_proof_transport_nonce")) {
      throw new Error("compile_gpu_proof_transport_nonce_reserved");
    }
    if (
      Object.prototype.hasOwnProperty.call(
        capturedPayload,
        "compute_expected_output_contract_hash",
      )
      || Object.prototype.hasOwnProperty.call(
        capturedPayload,
        "computeExpectedOutputContractHash",
      )
    ) {
      throw new Error("compile_compute_expected_output_contract_hash_reserved");
    }
    if (
      Object.prototype.hasOwnProperty.call(capturedPayload, "compute_expected_output_semantics")
      || Object.prototype.hasOwnProperty.call(capturedPayload, "computeExpectedOutputSemantics")
      || Object.prototype.hasOwnProperty.call(
        capturedPayload,
        "compute_expected_output_semantics_hash",
      )
      || Object.prototype.hasOwnProperty.call(
        capturedPayload,
        "computeExpectedOutputSemanticsHash",
      )
    ) {
      throw new Error("compile_compute_expected_output_semantics_reserved");
    }
    await this.runtimeEvidenceKeyPin.waitUntilPinned(GPU_PROOF_KEY_PIN_WAIT_MS);
    if (this.compileDC.readyState !== "open") {
      throw new Error(`compile_channel_not_open:${this.compileDC.readyState}`);
    }
    const intent = this.gpuParentRuntimeProofAdmission.issueCompileIntent(
      capturedExpectedOutputContractHash ?? null,
      capturedExpectedOutputSemantics?.semanticsHash ?? null,
    );

    try {
      const body = JSON.stringify({
        ...capturedPayload,
        gpu_proof_transport_nonce: intent.compileRequestNonce,
        ...(intent.computeExpectedOutputContractHash === null
          ? {}
          : {
              compute_expected_output_contract_hash:
                intent.computeExpectedOutputContractHash,
            }),
        ...(capturedExpectedOutputSemantics === null
          ? {}
          : {
              compute_expected_output_semantics:
                capturedExpectedOutputSemantics,
            }),
      });
      const maxBytes = compileChunkMaxBytes();
      if (Buffer.byteLength(body, "utf8") <= maxBytes) {
        const dispatchedAt = Date.now();
        this.compileDC.send(body);
        return compileDispatchReceipt(
          dispatchedAt,
          intent.correlationId,
          capturedExpectedOutputSemantics?.semanticsHash ?? null,
        );
      }

      const encoded = Buffer.from(body, "utf8").toString("base64");
      const chunkId = `compile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const { chunkChars, total } = chunkDataCharsForLimit(
        encoded.length,
        chunkId,
        maxBytes,
      );
      const dispatchedAt = Date.now();
      for (let seq = 0; seq < total; seq += 1) {
        const data = encoded.slice(seq * chunkChars, (seq + 1) * chunkChars);
        const frame = JSON.stringify({
          type: "compile-request-chunk",
          chunk_id: chunkId,
          seq,
          total,
          encoding: "base64",
          data,
        });
        this.compileDC.send(frame);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return compileDispatchReceipt(
        dispatchedAt,
        intent.correlationId,
        capturedExpectedOutputSemantics?.semanticsHash ?? null,
      );
    } catch (error) {
      this.gpuParentRuntimeProofAdmission.cancelCompileIntent(
        intent.compileRequestNonce,
      );
      throw error;
    }
  }

  gpuParentRuntimeProofAdmissionSnapshot(): GpuParentRuntimeProofAdmissionSnapshot {
    return this.gpuParentRuntimeProofAdmission.snapshot();
  }

  compileChannelReadyState(): "connecting" | "open" | "closing" | "closed" {
    return this.compileDC.readyState as
      | "connecting"
      | "open"
      | "closing"
      | "closed";
  }

  dispose(): void {
    this.runtimeEvidenceKeyPinUnsubscribe?.();
    this.runtimeEvidenceKeyPinUnsubscribe = null;
    this.hmr.dispose();
    this.gpuParentRuntimeProofAdmission.dispose();
    this.runtimeEvidenceReceiptConsumer.dispose();
    this.runtimeEvidenceReplayStore.dispose();
  }
}
