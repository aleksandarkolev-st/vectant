export const WARRANT_TWO_REPLICA_EVIDENCE_SCHEMA_VERSION = "synthi.warrant.twoReplicaFailureInjectionEvidence.v1";

const REQUIRED_PROBES = Object.freeze([
  "cross_replica_warrant_visibility",
  "cross_replica_idempotency",
  "concurrent_budget_reservation",
  "authority_failure_fail_closed",
  "audit_signer_failure_fail_closed",
  "managed_key_rotation",
  "session_lifecycle_failure_fail_closed",
  "audit_integrity_failure_fail_closed",
  "service_transport_enforced",
]);

const REQUIRED_METRICS = Object.freeze([
  "denied_checks",
  "stale_identities",
  "reservation_age",
  "replay_failures",
  "policy_violations",
]);

/**
 * Validates a redacted, deployment-produced two-replica warrant acceptance
 * artifact. The command that creates it is supplied by the release operator;
 * this repository supplies neither endpoints nor infrastructure commands.
 */
export function validateWarrantTwoReplicaEvidenceFromStdout(stdout) {
  let value;
  try {
    value = JSON.parse(String(stdout || "").trim());
  } catch {
    throw new Error("warrant_two_replica_evidence_json_invalid");
  }
  return validateWarrantTwoReplicaEvidence(value);
}

export function validateWarrantTwoReplicaEvidence(value) {
  const artifact = object(value, "warrant_two_replica_evidence_invalid");
  if (artifact.schema_version !== WARRANT_TWO_REPLICA_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("warrant_two_replica_evidence_schema_invalid");
  }
  if (!validTimestamp(artifact.observed_at)) throw new Error("warrant_two_replica_evidence_timestamp_invalid");
  const replicas = opaqueStrings(artifact.replica_ids, "warrant_two_replica_evidence_replicas_invalid");
  if (replicas.length !== 2) throw new Error("warrant_two_replica_evidence_exactly_two_replicas_required");

  const replicaSet = new Set(replicas);
  if (replicaSet.size !== replicas.length) throw new Error("warrant_two_replica_evidence_replicas_not_distinct");
  const probes = proofMap(artifact.probes, "warrant_two_replica_evidence_probes_invalid");
  for (const name of REQUIRED_PROBES) {
    const proof = probes.get(name);
    if (!proof) throw new Error(`warrant_two_replica_evidence_probe_missing:${name}`);
    if (proof.status !== "passed") throw new Error(`warrant_two_replica_evidence_probe_failed:${name}`);
    const proofReplicas = opaqueStrings(proof.replica_ids, `warrant_two_replica_evidence_probe_replicas_invalid:${name}`);
    if (
      proofReplicas.length !== replicas.length
      || new Set(proofReplicas).size !== proofReplicas.length
      || proofReplicas.some((id) => !replicaSet.has(id))
    ) {
      throw new Error(`warrant_two_replica_evidence_probe_scope_invalid:${name}`);
    }
    if (!sha256(proof.evidence_sha256)) throw new Error(`warrant_two_replica_evidence_probe_digest_invalid:${name}`);
  }

  const metrics = object(artifact.metrics, "warrant_two_replica_evidence_metrics_invalid");
  for (const name of REQUIRED_METRICS) {
    const metric = object(metrics[name], `warrant_two_replica_evidence_metric_missing:${name}`);
    if (metric.observed !== true || !sha256(metric.evidence_sha256)) {
      throw new Error(`warrant_two_replica_evidence_metric_invalid:${name}`);
    }
  }
  if (!sha256(artifact.deployment_revision_sha256)) {
    throw new Error("warrant_two_replica_evidence_revision_invalid");
  }

  return {
    schema_version: artifact.schema_version,
    observed_at: artifact.observed_at,
    replica_count: replicas.length,
    probe_count: REQUIRED_PROBES.length,
    metric_count: REQUIRED_METRICS.length,
    deployment_revision_sha256: artifact.deployment_revision_sha256,
  };
}

function object(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value;
}

function opaqueStrings(value, code) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  const values = value.map((entry) => typeof entry === "string" ? entry.trim() : "");
  if (values.some((entry) => !entry || entry.length > 512 || /[\r\n]/.test(entry))) throw new Error(code);
  return values;
}

function proofMap(value, code) {
  if (!Array.isArray(value)) throw new Error(code);
  const proofs = new Map();
  for (const raw of value) {
    const proof = object(raw, code);
    const name = typeof proof.name === "string" ? proof.name.trim() : "";
    if (!name || proofs.has(name)) throw new Error(code);
    proofs.set(name, proof);
  }
  return proofs;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function sha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}
