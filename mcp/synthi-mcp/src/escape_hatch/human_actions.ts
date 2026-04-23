/**
 * Human-action log — wire-only backing for synthi_recent_human_actions.
 *
 * Phase 1 has no worker-side hook to mark input as human-authored, so
 * the log is empty by default. Tests + future worker events append via
 * `recordHumanAction`; the tool surface is live so agents can branch on
 * `{actions:[]}` vs `{actions:[…]}` once the hook lands.
 *
 * Capped ring to prevent unbounded growth — same pattern as the
 * event-log buffer.
 */

export interface HumanAction {
  seq: number;
  ts: number;
  kind: "mouse" | "keyboard" | "other";
  source_peer_id?: string;
  detail?: Record<string, unknown>;
}

const CAPACITY = 256;

class HumanActionLog {
  private readonly buffer: HumanAction[] = [];
  private nextSeq = 1;

  record(action: Omit<HumanAction, "seq" | "ts"> & { ts?: number }): HumanAction {
    const entry: HumanAction = {
      seq: this.nextSeq++,
      ts: action.ts ?? Date.now(),
      kind: action.kind,
      ...(action.source_peer_id !== undefined ? { source_peer_id: action.source_peer_id } : {}),
      ...(action.detail !== undefined ? { detail: action.detail } : {}),
    };
    this.buffer.push(entry);
    if (this.buffer.length > CAPACITY) this.buffer.shift();
    return entry;
  }

  query(sinceSeq?: number, limit: number = 64): HumanAction[] {
    const lim = Math.max(1, Math.min(256, Math.floor(limit)));
    const base = sinceSeq === undefined
      ? this.buffer
      : this.buffer.filter((a) => a.seq > sinceSeq);
    return base.slice(-lim);
  }

  size(): number {
    return this.buffer.length;
  }

  _resetForTests(): void {
    this.buffer.length = 0;
    this.nextSeq = 1;
  }
}

export const humanActions = new HumanActionLog();
