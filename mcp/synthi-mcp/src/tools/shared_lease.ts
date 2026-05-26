import type { AttachedSession } from "../session.js";
import type { InputLease, LeasePriority, LeaseScope } from "../arbitration/lease.js";

export type SharedLeaseOp = "acquire" | "release" | "renew" | "force-release" | "validate";

export interface SharedLeaseOk {
  ok: true;
  lease?: InputLease;
  released?: string[];
  evicted_lease_id?: string;
  reentrant?: boolean;
}

export interface SharedLeaseError {
  ok: false;
  error: string;
  detail: Record<string, unknown>;
}

export async function requestSharedLease(
  attached: AttachedSession,
  payload: {
    op: SharedLeaseOp;
    lease_id?: string;
    lease_ms?: number;
    extend_ms?: number;
    owner?: string;
    scope?: LeaseScope[];
    takeover?: boolean;
    preemptible?: boolean;
    priority?: LeasePriority;
    reason?: string | null;
    forced_by?: string;
    peer_id?: string;
  },
  timeoutMs = 4_000
): Promise<SharedLeaseOk | SharedLeaseError | null> {
  const channels = attached.channels as unknown as {
    requestInputLease?: (payload: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;
  } | undefined;
  if (typeof channels?.requestInputLease !== "function") return null;
  const response = await channels.requestInputLease(
    {
      op: payload.op,
      sessionId: attached.sessionId,
      ...(payload.lease_id !== undefined ? { lease_id: payload.lease_id } : {}),
      ...(payload.lease_ms !== undefined ? { lease_ms: payload.lease_ms } : {}),
      ...(payload.extend_ms !== undefined ? { extend_ms: payload.extend_ms } : {}),
      ...(payload.owner !== undefined ? { owner: payload.owner } : {}),
      ...(payload.scope !== undefined ? { scope: payload.scope } : {}),
      ...(payload.takeover !== undefined ? { takeover: payload.takeover } : {}),
      ...(payload.preemptible !== undefined ? { preemptible: payload.preemptible } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
      ...(payload.forced_by !== undefined ? { forced_by: payload.forced_by } : {}),
      ...(payload.peer_id !== undefined ? { peer_id: payload.peer_id } : {}),
    },
    timeoutMs
  );
  if (response["ok"] !== true) {
    return {
      ok: false,
      error: typeof response["error"] === "string" ? response["error"] : "LEASE_DENIED",
      detail: response as Record<string, unknown>,
    };
  }
  const lease = parseLease(response["lease"]);
  return {
    ok: true,
    ...(lease ? { lease } : {}),
    ...(Array.isArray(response["released"]) ? { released: response["released"].filter((v): v is string => typeof v === "string") } : {}),
    ...(typeof response["evicted_lease_id"] === "string" ? { evicted_lease_id: response["evicted_lease_id"] } : {}),
    ...(response["reentrant"] === true ? { reentrant: true } : {}),
  };
}

function parseLease(raw: unknown): InputLease | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (
    typeof v["lease_id"] !== "string" ||
    typeof v["session_id"] !== "string" ||
    typeof v["owner"] !== "string" ||
    typeof v["acquired_at"] !== "number" ||
    typeof v["expires_at"] !== "number" ||
    typeof v["lease_ms"] !== "number"
  ) {
    return null;
  }
  const scope: LeaseScope[] = Array.isArray(v["scope"])
    ? v["scope"].filter((item): item is LeaseScope => item === "mouse" || item === "keyboard")
    : ["mouse", "keyboard"];
  return {
    lease_id: v["lease_id"],
    session_id: v["session_id"],
    acquired_at: v["acquired_at"],
    expires_at: v["expires_at"],
    lease_ms: v["lease_ms"],
    owner: v["owner"],
    scope: scope.length > 0 ? scope : ["mouse", "keyboard"],
    preemptible: typeof v["preemptible"] === "boolean" ? v["preemptible"] : true,
    priority: v["priority"] === "urgent_human_override" ? "urgent_human_override" : "normal",
    reason: typeof v["reason"] === "string" ? v["reason"] : null,
    continuous_owner_since: typeof v["continuous_owner_since"] === "number"
      ? v["continuous_owner_since"]
      : v["acquired_at"],
  };
}
