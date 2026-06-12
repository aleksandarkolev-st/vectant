import type { DojoEvidenceLedgerRecord } from "./types.js";
import {
  dojoRedactionDigestHex,
  redactDojoEvidenceArtifact,
  type DojoRedactableArtifactKind,
  type DojoRedactionRuleApplication,
  verifyDojoRedactionManifest,
} from "./redaction.js";

export interface DojoEvidenceExportArtifactInput {
  artifact_id: string;
  artifact_kind: DojoRedactableArtifactKind;
  content: unknown;
  evidence_record?: DojoEvidenceLedgerRecord;
  artifact_uri?: string;
  source_refs?: string[];
}

export interface DojoRedactedEvidenceExportItem {
  artifact_id: string;
  artifact_kind: DojoRedactableArtifactKind;
  evidence_record_id: string | null;
  artifact_uri: string | null;
  original_artifact_sha256: string;
  redacted_artifact_sha256: string;
  redaction_manifest_sha256: string;
  redaction_id: string;
  redaction_count: number;
  rules_applied: DojoRedactionRuleApplication[];
  source_refs: string[];
}

export interface DojoRedactedEvidenceExportManifest {
  schema_version: "synthi.dojo.redactedEvidenceExport.v1";
  tenant_id: string;
  workspace_id: string;
  generated_at: string;
  artifact_count: number;
  artifacts: DojoRedactedEvidenceExportItem[];
  excluded: string[];
  blocked_by: string[];
}

export function buildDojoRedactedEvidenceExportManifest(input: {
  tenant_id: string;
  workspace_id: string;
  artifacts: DojoEvidenceExportArtifactInput[];
  generated_at?: string;
}): DojoRedactedEvidenceExportManifest {
  const tenantId = requiredId(input.tenant_id, "tenant_id");
  const workspaceId = requiredId(input.workspace_id, "workspace_id");
  const generatedAt = input.generated_at ?? new Date().toISOString();
  const artifacts = input.artifacts.map((artifact) => buildExportItem({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    generated_at: generatedAt,
    artifact,
  }));
  return {
    schema_version: "synthi.dojo.redactedEvidenceExport.v1",
    tenant_id: tenantId,
    workspace_id: workspaceId,
    generated_at: generatedAt,
    artifact_count: artifacts.length,
    artifacts,
    excluded: ["raw_artifact_content", "unredacted_screenshots", "secrets", "cookies", "tokens", "production_payloads"],
    blocked_by: [],
  };
}

function buildExportItem(input: {
  tenant_id: string;
  workspace_id: string;
  generated_at: string;
  artifact: DojoEvidenceExportArtifactInput;
}): DojoRedactedEvidenceExportItem {
  const artifactId = requiredId(input.artifact.artifact_id, "artifact_id");
  const redaction = redactDojoEvidenceArtifact({
    artifact_kind: input.artifact.artifact_kind,
    content: input.artifact.content,
    created_at: input.generated_at,
  });
  const verification = verifyDojoRedactionManifest(redaction);
  if (!verification.ok) {
    throw new Error(`dojo_evidence_export_redaction_manifest_invalid:${verification.blocked_by.join(",")}`);
  }

  const originalArtifactSha256 = dojoRedactionDigestHex(redaction.manifest.original_sha256);
  const redactedArtifactSha256 = dojoRedactionDigestHex(redaction.manifest.redacted_sha256);
  const redactionManifestSha256 = dojoRedactionDigestHex(redaction.manifest.manifest_sha256);
  validateEvidenceRecordBinding({
    tenant_id: input.tenant_id,
    workspace_id: input.workspace_id,
    original_artifact_sha256: originalArtifactSha256,
    redaction_manifest_sha256: redactionManifestSha256,
    record: input.artifact.evidence_record,
  });

  return {
    artifact_id: artifactId,
    artifact_kind: input.artifact.artifact_kind,
    evidence_record_id: input.artifact.evidence_record?.record_id ?? null,
    artifact_uri: redactedArtifactUri(input.artifact.artifact_uri ?? input.artifact.evidence_record?.artifact_uri ?? null, input.generated_at),
    original_artifact_sha256: originalArtifactSha256,
    redacted_artifact_sha256: redactedArtifactSha256,
    redaction_manifest_sha256: redactionManifestSha256,
    redaction_id: redaction.manifest.redaction_id,
    redaction_count: redaction.manifest.redaction_count,
    rules_applied: redaction.manifest.rules_applied,
    source_refs: [...new Set(input.artifact.source_refs ?? input.artifact.evidence_record?.source_refs ?? [])].sort(),
  };
}

function redactedArtifactUri(value: string | null, generatedAt: string): string | null {
  if (!value) return null;
  const redaction = redactDojoEvidenceArtifact({
    artifact_kind: "file_name",
    content: value,
    created_at: generatedAt,
  });
  return typeof redaction.redacted_content === "string" ? redaction.redacted_content : value;
}

function validateEvidenceRecordBinding(input: {
  tenant_id: string;
  workspace_id: string;
  original_artifact_sha256: string;
  redaction_manifest_sha256: string;
  record?: DojoEvidenceLedgerRecord;
}): void {
  if (!input.record) return;
  if (input.record.tenant_id !== input.tenant_id || input.record.workspace_id !== input.workspace_id) {
    throw new Error("dojo_evidence_export_tenant_scope_mismatch");
  }
  if (input.record.artifact_sha256 !== input.original_artifact_sha256) {
    throw new Error("dojo_evidence_export_artifact_digest_mismatch");
  }
  if (!input.record.redaction_manifest_sha256) {
    throw new Error("dojo_evidence_export_redaction_manifest_required");
  }
  if (input.record.redaction_manifest_sha256 !== input.redaction_manifest_sha256) {
    throw new Error("dojo_evidence_export_redaction_manifest_mismatch");
  }
}

function requiredId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_evidence_export_${field}_required`);
  return trimmed;
}
