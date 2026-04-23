/**
 * Escape-hatch pending-question queue — Phase 3 (ultraplan §Escape hatches).
 *
 * Phase 1 wire-only returned `escape_hatch_backend_not_implemented`. Phase 3
 * lands a real queue that an operator UI (or a second MCP client acting as
 * operator) can drain. The flow:
 *
 *   agent              MCP queue             operator (UI / tool client)
 *     │                    │                             │
 *     │ request_human() ─▶ │ enqueue(pending)            │
 *     │                    │ ─ notify subscribers ─────▶ │
 *     │  (awaits promise)  │                             │ read queue resource
 *     │                    │                             │ synthi_answer_escape_hatch(id, answer)
 *     │                    │ ◀──── resolve(id, answer) ──│
 *     │ ◀──── answer ────  │                             │
 *
 * Timeouts: each enqueue carries a caller timeout. When it fires the queue
 * marks the entry `timed_out`, removes it, and resolves the promise with
 * `{status:"timeout"}` so the agent sees a deterministic terminal state.
 *
 * Cap: 32 pending entries. Over-cap enqueue returns a distinct error —
 * prevents a runaway agent from DoS'ing the operator console.
 */

import { randomUUID } from "node:crypto";

export type EscapeHatchKind = "request_human" | "annotate_and_ask";

export interface PendingEscapeHatch {
  pending_id: string;
  kind: EscapeHatchKind;
  created_at: number;
  expires_at: number;
  question: string;
  screenshot_bytes?: number; // byte length only — blob stored separately
  screenshot_base64?: string;
  detail?: Record<string, unknown>;
  source_tool: string;
}

export type EscapeHatchOutcome =
  | { status: "answered"; answer: unknown; answered_at: number; operator_id?: string }
  | { status: "timeout"; timed_out_at: number }
  | { status: "canceled"; canceled_at: number; reason: string };

interface PendingWithResolver extends PendingEscapeHatch {
  resolver: (outcome: EscapeHatchOutcome) => void;
  timer: NodeJS.Timeout;
}

export type QueueListener = (entry: PendingEscapeHatch) => void;

export const MAX_PENDING = 32;

class EscapeHatchQueue {
  private readonly entries = new Map<string, PendingWithResolver>();
  private readonly listeners = new Set<QueueListener>();

  list(): PendingEscapeHatch[] {
    return [...this.entries.values()]
      .map((p) => {
        const entry: PendingEscapeHatch = {
          pending_id: p.pending_id,
          kind: p.kind,
          created_at: p.created_at,
          expires_at: p.expires_at,
          question: p.question,
          source_tool: p.source_tool,
          ...(p.screenshot_bytes !== undefined ? { screenshot_bytes: p.screenshot_bytes } : {}),
          ...(p.detail !== undefined ? { detail: p.detail } : {}),
        };
        return entry;
      })
      .sort((a, b) => a.created_at - b.created_at);
  }

  get(id: string): PendingEscapeHatch | undefined {
    const v = this.entries.get(id);
    if (!v) return undefined;
    const out: PendingEscapeHatch = {
      pending_id: v.pending_id,
      kind: v.kind,
      created_at: v.created_at,
      expires_at: v.expires_at,
      question: v.question,
      source_tool: v.source_tool,
      ...(v.screenshot_bytes !== undefined ? { screenshot_bytes: v.screenshot_bytes } : {}),
      ...(v.screenshot_base64 !== undefined ? { screenshot_base64: v.screenshot_base64 } : {}),
      ...(v.detail !== undefined ? { detail: v.detail } : {}),
    };
    return out;
  }

  size(): number {
    return this.entries.size;
  }

  onPending(cb: QueueListener): () => void {
    this.listeners.add(cb);
    return (): void => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Enqueue a pending question and return a promise that settles when the
   * operator answers, the timeout fires, or the queue is cancelled.
   */
  enqueue(req: {
    kind: EscapeHatchKind;
    question: string;
    screenshot_base64?: string;
    timeoutMs: number;
    source_tool: string;
    detail?: Record<string, unknown>;
  }): { pending_id: string; promise: Promise<EscapeHatchOutcome> } | { error: "escape_hatch_queue_full"; capacity: number } {
    if (this.entries.size >= MAX_PENDING) {
      return { error: "escape_hatch_queue_full", capacity: MAX_PENDING };
    }
    const pending_id = `pending_${randomUUID()}`;
    const created_at = Date.now();
    const expires_at = created_at + Math.max(1000, Math.floor(req.timeoutMs));
    const promise = new Promise<EscapeHatchOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const existing = this.entries.get(pending_id);
        if (!existing) return;
        this.entries.delete(pending_id);
        existing.resolver({ status: "timeout", timed_out_at: Date.now() });
      }, expires_at - created_at);
      const entry: PendingWithResolver = {
        pending_id,
        kind: req.kind,
        created_at,
        expires_at,
        question: req.question,
        source_tool: req.source_tool,
        ...(req.screenshot_base64 !== undefined
          ? { screenshot_base64: req.screenshot_base64, screenshot_bytes: req.screenshot_base64.length }
          : {}),
        ...(req.detail !== undefined ? { detail: req.detail } : {}),
        resolver: resolve,
        timer,
      };
      this.entries.set(pending_id, entry);
      for (const l of this.listeners) {
        try { l(this.get(pending_id)!); } catch { /* listener errors swallowed */ }
      }
    });
    return { pending_id, promise };
  }

  /**
   * Operator answer. Returns true if a live pending matched.
   */
  resolve(pending_id: string, answer: unknown, operator_id?: string): boolean {
    const entry = this.entries.get(pending_id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(pending_id);
    const outcome: EscapeHatchOutcome = {
      status: "answered",
      answer,
      answered_at: Date.now(),
      ...(operator_id !== undefined ? { operator_id } : {}),
    };
    entry.resolver(outcome);
    return true;
  }

  /**
   * Cancel one pending (e.g. agent detach). Returns true if matched.
   */
  cancel(pending_id: string, reason: string = "canceled"): boolean {
    const entry = this.entries.get(pending_id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(pending_id);
    entry.resolver({ status: "canceled", canceled_at: Date.now(), reason });
    return true;
  }

  /** Cancel every pending — used during session teardown. */
  cancelAll(reason: string = "session_detach"): number {
    const ids = [...this.entries.keys()];
    for (const id of ids) this.cancel(id, reason);
    return ids.length;
  }

  _resetForTests(): void {
    for (const [, v] of this.entries) clearTimeout(v.timer);
    this.entries.clear();
    this.listeners.clear();
  }
}

export const escapeHatchQueue = new EscapeHatchQueue();
