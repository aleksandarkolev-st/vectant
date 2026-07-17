import { createHmac, randomBytes } from "node:crypto";

export type PublicWorkerEventClass =
  | "security"
  | "human_action"
  | "input_ack"
  | "input_lease_result"
  | "input_rejected";

const PUBLIC_WORKER_DIAGNOSTIC_SCHEMA = "synthi.worker.public_event_diagnostic.v1";
const PUBLIC_WORKER_DIAGNOSTIC_AUTHORITY =
  "worker_event_diagnostic_only_not_gpu_hmr_acceptance";
const publicWorkerReferenceKey = randomBytes(32);

function stringField(raw: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function booleanField(raw: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function nonNegativeNumberField(
  raw: Record<string, unknown>,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function reference(kind: string, value: string): string {
  const digest = createHmac("sha256", publicWorkerReferenceKey)
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex");
  return `worker-${kind}-ref:sha256:${digest}`;
}

export function projectPublicWorkerDiagnostic(
  eventClass: PublicWorkerEventClass,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const reason = stringField(raw, ["reason_code", "reasonCode", "reason", "message", "error"]);
  const dispatchId = stringField(raw, ["dispatch_id", "dispatchId"]);
  const leaseId = stringField(raw, ["lease_id", "leaseId"]);
  const owner = stringField(raw, ["owner"]);
  const peerId = stringField(raw, ["peer_id", "peerId"]);
  const accepted = booleanField(raw, ["accepted"]);
  const queuePosition = nonNegativeNumberField(raw, ["queue_position", "queuePosition"]);
  const detailPresent = raw.detail !== undefined;

  return {
    schemaVersion: PUBLIC_WORKER_DIAGNOSTIC_SCHEMA,
    proofAuthority: PUBLIC_WORKER_DIAGNOSTIC_AUTHORITY,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    eventClass,
    reasonPresent: reason !== null,
    detailPresent,
    ...(reason !== null ? { reasonRef: reference("reason", reason) } : {}),
    ...(dispatchId !== null ? { dispatchRef: reference("dispatch", dispatchId) } : {}),
    ...(leaseId !== null ? { leaseRef: reference("lease", leaseId) } : {}),
    ...(owner !== null ? { ownerRef: reference("owner", owner) } : {}),
    ...(peerId !== null ? { peerRef: reference("peer", peerId) } : {}),
    ...(accepted !== null ? { accepted } : {}),
    ...(queuePosition !== null ? { queuePosition } : {}),
  };
}

export function publicWorkerReference(
  kind: "lease" | "owner" | "peer" | "stage",
  value: string
): string {
  return reference(kind, value);
}
