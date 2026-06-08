import { createHash } from "node:crypto";
import type { RTCDataChannel } from "werift";
import {
  classifyGpuHmrProofMessage,
  gpuHmrProofMatches,
  type GpuHmrProofMatchOpts,
  type GpuHmrProofTelemetry,
} from "./gpu_proof.js";

/**
 * HMR normalizer. Parses the four wire families emitted by the worker on the
 * `build-log` data channel and resolves on the first terminal event.
 *
 * Wire families verified (see F2 table in the implementation plan):
 *   1. CandidateNotification — `{event:"Promoted"|"RolledBack"|"Discarded", data:...}`
 *      from `worker/src/hmr/candidate_notification.rs`. Fires from both
 *      adapter-handled and runner-reload paths (adapter: `handler.rs:1833`;
 *      runner: `handler.rs:1957`).
 *   2. Bare HmrStatus — `{status:"applied"|"rejected"|"compile-error"|...}`
 *      from `runtime/capability.rs::HmrStatus`, emitted via runner stderr →
 *      `compiler/stages/runner.rs:557`. Runner-reload path only.
 *   3. Rollback — `{type:"hmr-status", status:"rejected", ...}` from
 *      `hmr/rollback_notification.rs:41`.
 *   4. Compile diagnostics — `{type:"compile-diagnostics", error_count, ...}`
 *      from `compile_core.rs`, `compile_gui.rs`, `compile_runner.rs`. Only
 *      terminal when `error_count > 0`.
 *
 * Non-terminal (ignore): Enqueued / Loading / HealthCheck* / PromotionDecision,
 * `{type:"hmr-status", status:"reload-planned"}`, `{status:"done"}` (compile
 * pipeline completion, NOT HMR applied), `{status:"host-kv-*"|"capability-detected"}`,
 * stdout/stderr pass-through.
 */

export type HmrTerminalStatus =
  | "applied"
  | "rejected"
  | "compile-error"
  | "full-reload-required"
  | "discarded"
  | "timeout";

export type HmrTerminalSource =
  | "candidate_notification"
  | "hmr_status"
  | "rollback_notification"
  | "compile_diagnostics"
  | "timeout";

export interface HmrTerminalEvent {
  status: HmrTerminalStatus;
  source: HmrTerminalSource;
  elapsedMs: number;
  detail?: Record<string, unknown>;
  observedAt?: number;
  retained?: boolean;
  sequence?: number;
}

export type WireMessage = Record<string, unknown>;

interface StructuredJsonChunk {
  chunkId: string;
  sha256: string;
  byteLength: number;
  index: number;
  total: number;
  data: string;
}

interface StructuredJsonChunkBuffer {
  sha256: string;
  byteLength: number;
  total: number;
  chunks: Map<number, Buffer>;
  createdAt: number;
  lastSeenAt: number;
}

const STRUCTURED_JSON_CHUNK_TYPE = "structured-json-chunk";
const STRUCTURED_JSON_CHUNK_BUFFER_LIMIT = 32;
const STRUCTURED_JSON_CHUNK_TTL_MS = 120_000;

export interface HmrClassification {
  status: HmrTerminalStatus;
  source: HmrTerminalSource;
  detail: Record<string, unknown>;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseWireJsonObject(text: string): WireMessage | null {
  try {
    return objectOrNull(JSON.parse(text)) as WireMessage | null;
  } catch {
    return null;
  }
}

function embeddedJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      candidates.push(text.slice(start, i + 1));
      start = -1;
    }
  }
  return candidates;
}

export function parseWireMessages(text: string): WireMessage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const direct = parseWireJsonObject(trimmed);
  if (direct !== null) return [direct];

  const messages: WireMessage[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const lineDirect = parseWireJsonObject(line.trim());
    if (lineDirect !== null) {
      messages.push(lineDirect);
      continue;
    }
    for (const candidate of embeddedJsonObjectCandidates(line)) {
      const parsed = parseWireJsonObject(candidate);
      if (parsed !== null) messages.push(parsed);
    }
  }
  return messages;
}

/**
 * Pure classifier: given a parsed JSON message, return the terminal status
 * it represents, or null if it is intermediate / unknown.
 *
 * Ordering matters because some messages carry both a top-level `event`
 * (CandidateNotification) or `type` (hmr-status / compile-diagnostics) and
 * a `status` field; we check the tagged families first so those wins.
 */
export function classifyHmrMessage(msg: WireMessage): HmrClassification | null {
  // Family 1: CandidateNotification {event: "...", data: {...}}
  if (typeof msg.event === "string") {
    const data = (msg.data as Record<string, unknown> | undefined) ?? {};
    switch (msg.event) {
      case "Promoted":
        return { status: "applied", source: "candidate_notification", detail: data };
      case "RolledBack":
        return { status: "rejected", source: "candidate_notification", detail: data };
      case "Discarded":
        return { status: "discarded", source: "candidate_notification", detail: data };
      default:
        // Enqueued / Loading / HealthCheckStarted / HealthCheckCompleted /
        // PromotionDecision → non-terminal
        return null;
    }
  }

  // Family 3: {type:"hmr-status", status:"rejected"|"reload-planned", ...}
  if (msg.type === "hmr-status" && typeof msg.status === "string") {
    if (msg.status === "rejected") {
      return { status: "rejected", source: "rollback_notification", detail: msg };
    }
    // "reload-planned" and any future non-terminal planner statuses
    return null;
  }

  // Family 4: {type:"compile-diagnostics", error_count, diagnostics}
  if (msg.type === "compile-diagnostics") {
    const errorCount = msg.error_count;
    if (typeof errorCount === "number" && errorCount > 0) {
      return { status: "compile-error", source: "compile_diagnostics", detail: msg };
    }
    return null;
  }

  // Family 2: bare HmrStatus {status: "..."}
  if (typeof msg.status === "string") {
    switch (msg.status) {
      case "applied":
      case "state-migrated":
        return { status: "applied", source: "hmr_status", detail: msg };
      case "rejected":
        return { status: "rejected", source: "hmr_status", detail: msg };
      case "compile-error":
        return { status: "compile-error", source: "hmr_status", detail: msg };
      case "full-reload-required":
        return { status: "full-reload-required", source: "hmr_status", detail: msg };
      default:
        // "done" (compile complete, NOT HMR applied),
        // "host-kv-preserved"/"host-kv-reset-schema-mismatch",
        // "host-kv-ready", "capability-detected", "reload-planned" → non-terminal
        return null;
    }
  }

  return null;
}

type MessageHandler = (msg: WireMessage) => void;

export function terminalModule(detail: Record<string, unknown>): string | null {
  if (typeof detail.module === "string") return detail.module;
  const data = detail.data;
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).module === "string") {
    return (data as Record<string, unknown>).module as string;
  }
  return null;
}

export function terminalPreviewId(detail: Record<string, unknown>): string | null {
  if (typeof detail.preview_id === "string") return detail.preview_id;
  const data = detail.data;
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).preview_id === "string") {
    return (data as Record<string, unknown>).preview_id as string;
  }
  const nested = detail.detail;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).preview_id === "string") {
    return (nested as Record<string, unknown>).preview_id as string;
  }
  return null;
}

function terminalMatches(
  cls: HmrClassification,
  expectedModule?: string,
  expectedPreviewId?: string
): boolean {
  if (expectedModule) {
    const actualModule = terminalModule(cls.detail);
    if ((cls.status === "applied" || actualModule !== null) && actualModule !== expectedModule) {
      return false;
    }
  }
  if (expectedPreviewId && terminalPreviewId(cls.detail) !== expectedPreviewId) {
    return false;
  }
  return true;
}

interface RetainedHmrTerminalEvent {
  status: HmrTerminalStatus;
  source: HmrTerminalSource;
  detail: Record<string, unknown>;
  observedAt: number;
  sequence: number;
}

interface WaitForTerminalOpts {
  timeoutMs?: number;
  module?: string;
  sinceTs?: number;
  previewId?: string;
}

export class HmrNormalizer {
  private readonly listeners = new Set<MessageHandler>();
  private readonly unbind: () => void;
  private latestProof: GpuHmrProofTelemetry | null = null;
  private readonly structuredJsonChunks = new Map<string, StructuredJsonChunkBuffer>();
  private readonly proofHistory: GpuHmrProofTelemetry[] = [];
  private readonly terminalHistory: RetainedHmrTerminalEvent[] = [];
  private terminalSequence = 0;
  private static readonly TERMINAL_HISTORY_LIMIT = 128;
  private static readonly PROOF_HISTORY_LIMIT = 128;

  constructor(dc: RTCDataChannel) {
    const dcListener = (ev: Event): void => {
      const data = (ev as unknown as { data: unknown }).data;
      let text: string | null = null;
      if (typeof data === "string") {
        text = data;
      } else if (data instanceof ArrayBuffer) {
        text = Buffer.from(data).toString("utf8");
      } else if (ArrayBuffer.isView(data)) {
        text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
      }
      if (!text) return;
      const observedAt = Date.now();
      for (const parsed of parseWireMessages(text)) {
        for (const msg of this.expandStructuredJsonChunk(parsed, observedAt)) {
          this.rememberMessage(msg, observedAt);
        }
      }
    };
    dc.addEventListener("message", dcListener);
    this.unbind = (): void => dc.removeEventListener("message", dcListener);
  }

  private rememberMessage(parsed: WireMessage, observedAt: number): void {
    const cls = classifyHmrMessage(parsed);
    if (cls) this.rememberTerminal(cls, observedAt);
    const proof = classifyGpuHmrProofMessage(parsed, observedAt);
    if (proof) this.rememberGpuProof(proof);
    for (const listener of this.listeners) listener(parsed);
  }

  private expandStructuredJsonChunk(parsed: WireMessage, observedAt: number): WireMessage[] {
    const chunk = this.parseStructuredJsonChunk(parsed);
    if (chunk === null) return [parsed];

    const existing = this.structuredJsonChunks.get(chunk.chunkId);
    const buffer = existing ?? {
      sha256: chunk.sha256,
      byteLength: chunk.byteLength,
      total: chunk.total,
      chunks: new Map<number, Buffer>(),
      createdAt: observedAt,
      lastSeenAt: observedAt,
    };
    if (
      buffer.sha256 !== chunk.sha256
      || buffer.byteLength !== chunk.byteLength
      || buffer.total !== chunk.total
    ) {
      this.structuredJsonChunks.delete(chunk.chunkId);
      return [];
    }

    buffer.chunks.set(chunk.index, Buffer.from(chunk.data, "base64"));
    buffer.lastSeenAt = observedAt;
    this.structuredJsonChunks.set(chunk.chunkId, buffer);
    this.pruneStructuredJsonChunks(observedAt);
    if (buffer.chunks.size < buffer.total) return [];

    const parts: Buffer[] = [];
    for (let index = 0; index < buffer.total; index += 1) {
      const part = buffer.chunks.get(index);
      if (part === undefined) return [];
      parts.push(part);
    }
    this.structuredJsonChunks.delete(chunk.chunkId);
    const body = Buffer.concat(parts);
    const actualHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    if (body.byteLength !== buffer.byteLength || actualHash !== buffer.sha256) return [];
    return parseWireMessages(body.toString("utf8"));
  }

  private parseStructuredJsonChunk(parsed: WireMessage): StructuredJsonChunk | null {
    if (parsed.type !== STRUCTURED_JSON_CHUNK_TYPE) return null;
    const chunkId = typeof parsed.chunkId === "string" && parsed.chunkId.trim()
      ? parsed.chunkId.trim()
      : null;
    const sha256 = typeof parsed.sha256 === "string" && /^sha256:[a-f0-9]{64}$/i.test(parsed.sha256)
      ? parsed.sha256.toLowerCase()
      : null;
    const byteLength = typeof parsed.byteLength === "number" && Number.isInteger(parsed.byteLength)
      && parsed.byteLength > 0
      ? parsed.byteLength
      : null;
    const index = typeof parsed.index === "number" && Number.isInteger(parsed.index)
      && parsed.index >= 0
      ? parsed.index
      : null;
    const total = typeof parsed.total === "number" && Number.isInteger(parsed.total)
      && parsed.total > 0
      && parsed.total <= 4096
      ? parsed.total
      : null;
    const data = typeof parsed.data === "string" && parsed.data.trim() ? parsed.data : null;
    if (
      chunkId === null
      || sha256 === null
      || byteLength === null
      || index === null
      || total === null
      || data === null
      || index >= total
    ) {
      return null;
    }
    return { chunkId, sha256, byteLength, index, total, data };
  }

  private pruneStructuredJsonChunks(now: number): void {
    for (const [chunkId, buffer] of this.structuredJsonChunks) {
      if (now - buffer.lastSeenAt > STRUCTURED_JSON_CHUNK_TTL_MS) {
        this.structuredJsonChunks.delete(chunkId);
      }
    }
    while (this.structuredJsonChunks.size > STRUCTURED_JSON_CHUNK_BUFFER_LIMIT) {
      const oldest = [...this.structuredJsonChunks.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0]?.[0];
      if (oldest === undefined) break;
      this.structuredJsonChunks.delete(oldest);
    }
  }

  onMessage(cb: MessageHandler): () => void {
    this.listeners.add(cb);
    return (): void => {
      this.listeners.delete(cb);
    };
  }

  latestGpuProof(opts: GpuHmrProofMatchOpts = {}): GpuHmrProofTelemetry | null {
    if (Object.keys(opts).length === 0) return this.latestProof;
    for (const proof of this.proofHistory.slice().reverse()) {
      if (gpuHmrProofMatches(proof, opts)) return proof;
    }
    return null;
  }

  private rememberGpuProof(proof: GpuHmrProofTelemetry): void {
    this.latestProof = proof;
    this.proofHistory.push(proof);
    while (this.proofHistory.length > HmrNormalizer.PROOF_HISTORY_LIMIT) {
      this.proofHistory.shift();
    }
  }

  private rememberTerminal(cls: HmrClassification, observedAt: number): void {
    this.terminalSequence += 1;
    this.terminalHistory.push({
      status: cls.status,
      source: cls.source,
      detail: cls.detail,
      observedAt,
      sequence: this.terminalSequence,
    });
    while (this.terminalHistory.length > HmrNormalizer.TERMINAL_HISTORY_LIMIT) {
      this.terminalHistory.shift();
    }
  }

  private latestRetainedTerminal(opts: {
    sinceTs: number;
    module?: string;
    previewId?: string;
  }): RetainedHmrTerminalEvent | null {
    for (const retained of this.terminalHistory.slice().reverse()) {
      if (retained.observedAt < opts.sinceTs) continue;
      if (!terminalMatches(retained, opts.module, opts.previewId)) continue;
      return retained;
    }
    return null;
  }

  /**
   * Block until a terminal event arrives or the timeout elapses.
   *
   * First-wins: if `{event:"Promoted"}` and bare `{status:"applied"}` both
   * fire on the runner-reload path, the first one resolves and the second is
   * discarded. This matches the implementation plan F2 guidance and the
   * `hmr_normalize.test.ts` dedupe expectation.
   */
  async waitForTerminal(opts: WaitForTerminalOpts = {}): Promise<HmrTerminalEvent> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const expectedModule = opts.module?.trim();
    const expectedPreviewId = opts.previewId?.trim();
    const sinceTs = Number.isFinite(opts.sinceTs) && opts.sinceTs !== undefined
      ? opts.sinceTs
      : undefined;
    const start = Date.now();
    if (sinceTs !== undefined) {
      const retained = this.latestRetainedTerminal({
        sinceTs,
        module: expectedModule,
        previewId: expectedPreviewId,
      });
      if (retained) {
        return {
          status: retained.status,
          source: retained.source,
          elapsedMs: Math.max(0, retained.observedAt - sinceTs),
          detail: retained.detail,
          observedAt: retained.observedAt,
          retained: true,
          sequence: retained.sequence,
        };
      }
    }

    return new Promise<HmrTerminalEvent>((resolve) => {
      let settled = false;
      const unsub = this.onMessage((msg) => {
        if (settled) return;
        const cls = classifyHmrMessage(msg);
        if (!cls) return;
        if (!terminalMatches(cls, expectedModule, expectedPreviewId)) return;
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve({
          status: cls.status,
          source: cls.source,
          elapsedMs: Date.now() - start,
          detail: cls.detail,
          observedAt: Date.now(),
        });
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        resolve({
          status: "timeout",
          source: "timeout",
          elapsedMs: Date.now() - start,
        });
      }, timeoutMs);
    });
  }

  dispose(): void {
    this.listeners.clear();
    this.unbind();
  }
}
