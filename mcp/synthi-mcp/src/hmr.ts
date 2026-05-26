import type { RTCDataChannel } from "werift";
import {
  classifyGpuHmrProofMessage,
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
}

export type WireMessage = Record<string, unknown>;

export interface HmrClassification {
  status: HmrTerminalStatus;
  source: HmrTerminalSource;
  detail: Record<string, unknown>;
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

function terminalModule(detail: Record<string, unknown>): string | null {
  if (typeof detail.module === "string") return detail.module;
  const data = detail.data;
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).module === "string") {
    return (data as Record<string, unknown>).module as string;
  }
  return null;
}

export class HmrNormalizer {
  private readonly listeners = new Set<MessageHandler>();
  private readonly unbind: () => void;
  private latestProof: GpuHmrProofTelemetry | null = null;

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
      let parsed: WireMessage;
      try {
        parsed = JSON.parse(text) as WireMessage;
      } catch {
        return;
      }
      const proof = classifyGpuHmrProofMessage(parsed);
      if (proof) this.latestProof = proof;
      for (const listener of this.listeners) listener(parsed);
    };
    dc.addEventListener("message", dcListener);
    this.unbind = (): void => dc.removeEventListener("message", dcListener);
  }

  onMessage(cb: MessageHandler): () => void {
    this.listeners.add(cb);
    return (): void => {
      this.listeners.delete(cb);
    };
  }

  latestGpuProof(): GpuHmrProofTelemetry | null {
    return this.latestProof;
  }

  /**
   * Block until a terminal event arrives or the timeout elapses.
   *
   * First-wins: if `{event:"Promoted"}` and bare `{status:"applied"}` both
   * fire on the runner-reload path, the first one resolves and the second is
   * discarded. This matches the implementation plan F2 guidance and the
   * `hmr_normalize.test.ts` dedupe expectation.
   */
  async waitForTerminal(opts: { timeoutMs?: number; module?: string } = {}): Promise<HmrTerminalEvent> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const expectedModule = opts.module?.trim();
    const start = Date.now();

    return new Promise<HmrTerminalEvent>((resolve) => {
      let settled = false;
      const unsub = this.onMessage((msg) => {
        if (settled) return;
        const cls = classifyHmrMessage(msg);
        if (!cls) return;
        if (
          expectedModule &&
          cls.status === "applied" &&
          terminalModule(cls.detail) !== expectedModule
        ) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        unsub();
        resolve({
          status: cls.status,
          source: cls.source,
          elapsedMs: Date.now() - start,
          detail: cls.detail,
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
