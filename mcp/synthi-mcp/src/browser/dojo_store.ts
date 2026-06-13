import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DojoSkill } from "./dojo.js";
import type { DojoCaseLawRecord } from "../dojo/case_law/registry.js";
import { publishedToolNamesForSkill, publishedWorkflowBindingForSkill, type DojoPublishedWorkflowBinding } from "../dojo/store/published_workflow_index.js";
import type {
  DojoCaseLawRecordFilter,
  DojoControlPlaneStore,
  DojoAuditActor,
  DojoAuditEventInput,
  DojoAuditEventListFilter,
  DojoAuditEventRecord,
  DojoGhostShadowEvidenceFilter,
  DojoGhostShadowEvidenceRecord,
  DojoPermissionUpgradeRequestFilter,
  DojoPermissionUpgradeRequestRecord,
  DojoProofConsumeResult,
  DojoProofCapsuleRecord,
} from "../dojo/store/interfaces.js";

export type {
  DojoApprovalStore,
  DojoAuditActor,
  DojoAuditEventInput,
  DojoAuditEventListFilter,
  DojoAuditEventRecord,
  DojoAuditStore,
  DojoCaseLawRecordFilter,
  DojoCaseLawStore,
  DojoControlPlaneStore,
  DojoEvidenceStore,
  DojoGhostShadowEvidenceFilter,
  DojoGhostShadowEvidenceRecord,
  DojoGhostShadowEvidenceStore,
  DojoLicenseStore,
  DojoPermissionUpgradeRequestFilter,
  DojoPermissionUpgradeRequestRecord,
  DojoPermissionUpgradeRequestStatus,
  DojoProofConsumeResult,
  DojoProofCapsuleRecord,
  DojoProofStore,
  DojoSkillStore,
  DojoSourceContractStore,
  DojoStoreTransaction,
  DojoStoreTransactionOptions,
  DojoTransactionalStore,
  MaybePromise,
} from "../dojo/store/interfaces.js";

export class InMemoryDojoSkillStore implements DojoControlPlaneStore {
  private readonly skills = new Map<string, DojoSkill>();
  private readonly workflowIndex = new Map<string, string>();
  private readonly toolIndex = new Map<string, string>();
  private readonly proofRecords = new Map<string, DojoProofCapsuleRecord>();
  private readonly permissionUpgradeRequests = new Map<string, DojoPermissionUpgradeRequestRecord>();
  private readonly caseLawRecords = new Map<string, DojoCaseLawRecord>();
  private readonly ghostShadowEvidence = new Map<string, DojoGhostShadowEvidenceRecord>();
  private readonly auditEvents = new Map<string, DojoAuditEventRecord>();

  saveSkill(skill: DojoSkill): void {
    const clone = cloneJson(skill);
    this.skills.set(clone.skill_id, clone);
    this.workflowIndex.set(clone.workflow_id, clone.skill_id);
    this.removeToolIndexesForSkill(clone.skill_id);
    for (const toolName of publishedToolNamesForSkill(clone)) {
      this.toolIndex.set(toolName, clone.skill_id);
    }
  }

  getSkill(skillId: string): DojoSkill | null {
    const skill = this.skills.get(skillId);
    return skill ? cloneJson(skill) : null;
  }

  getSkillByWorkflowId(workflowId: string): DojoSkill | null {
    const skillId = this.workflowIndex.get(workflowId);
    return skillId ? this.getSkill(skillId) : null;
  }

  getSkillByPublishedToolName(toolName: string): DojoSkill | null {
    const skillId = this.toolIndex.get(toolName);
    return skillId ? this.getSkill(skillId) : null;
  }

  getPublishedWorkflowBindingByWorkflowId(workflowId: string): DojoPublishedWorkflowBinding | null {
    const skill = this.getSkillByWorkflowId(workflowId);
    return skill ? publishedWorkflowBindingForSkill(skill) : null;
  }

  getPublishedWorkflowBindingByToolName(toolName: string): DojoPublishedWorkflowBinding | null {
    const skill = this.getSkillByPublishedToolName(toolName);
    return skill ? publishedWorkflowBindingForSkill(skill) : null;
  }

  listSkills(): DojoSkill[] {
    return [...this.skills.values()].map(cloneJson);
  }

  saveProofRecord(record: DojoProofCapsuleRecord): void {
    this.proofRecords.set(record.capsule_id, cloneJson(record));
  }

  getProofRecord(capsuleId: string): DojoProofCapsuleRecord | null {
    const record = this.proofRecords.get(capsuleId);
    return record ? cloneJson(record) : null;
  }

  listProofRecords(): DojoProofCapsuleRecord[] {
    return [...this.proofRecords.values()].map(cloneJson);
  }

  markProofCapsuleValidated(capsuleId: string, now: string = new Date().toISOString()): DojoProofCapsuleRecord | null {
    const record = this.proofRecords.get(capsuleId);
    if (!record) return null;
    const validated = {
      ...record,
      last_validated_at: now,
    };
    this.proofRecords.set(capsuleId, cloneJson(validated));
    return cloneJson(validated);
  }

  markProofCapsuleUsed(capsuleId: string, runId: string, now: string = new Date().toISOString()): DojoProofConsumeResult {
    const record = this.proofRecords.get(capsuleId);
    if (!record) return proofConsumeBlocked(null, "missing", "proof_capsule_not_issued_by_registry");
    if (record.status === "revoked") return proofConsumeBlocked(record, "revoked", "proof_capsule_revoked");
    if (record.status === "used") return proofConsumeBlocked(record, "already_used", "proof_capsule_replay_detected");
    const used = {
      ...record,
      status: "used" as const,
      first_used_at: record.first_used_at ?? now,
      last_validated_at: now,
    };
    this.proofRecords.set(capsuleId, cloneJson(used));
    this.appendAuditEvent(proofUseAuditEventInput(used, runId, now));
    return { ok: true, record: cloneJson(used), status: "used", blocked_by: [] };
  }

  savePermissionUpgradeRequest(record: DojoPermissionUpgradeRequestRecord): void {
    this.permissionUpgradeRequests.set(record.request_id, cloneJson(record));
  }

  listPermissionUpgradeRequests(filter: DojoPermissionUpgradeRequestFilter = {}): DojoPermissionUpgradeRequestRecord[] {
    return filterPermissionUpgradeRequests([...this.permissionUpgradeRequests.values()], filter).map(cloneJson);
  }

  saveCaseLawRecord(record: DojoCaseLawRecord): void {
    this.caseLawRecords.set(record.case_id, cloneJson(record));
  }

  getCaseLawRecord(caseId: string): DojoCaseLawRecord | null {
    const record = this.caseLawRecords.get(caseId);
    return record ? cloneJson(record) : null;
  }

  listCaseLawRecords(filter: DojoCaseLawRecordFilter = {}): DojoCaseLawRecord[] {
    return filterCaseLawRecords([...this.caseLawRecords.values()], filter).map(cloneJson);
  }

  saveGhostShadowEvidence(record: DojoGhostShadowEvidenceRecord): void {
    this.ghostShadowEvidence.set(record.evidence_id, cloneJson(record));
  }

  listGhostShadowEvidence(filter: DojoGhostShadowEvidenceFilter = {}): DojoGhostShadowEvidenceRecord[] {
    return filterGhostShadowEvidence([...this.ghostShadowEvidence.values()], filter).map(cloneJson);
  }

  appendAuditEvent(event: DojoAuditEventInput): DojoAuditEventRecord {
    const record = auditEventRecordFromInput(event);
    if (this.auditEvents.has(record.audit_event_id)) throw new Error("dojo_audit_event_already_exists");
    this.auditEvents.set(record.audit_event_id, cloneJson(record));
    return cloneJson(record);
  }

  listAuditEvents(filter: DojoAuditEventListFilter = {}): DojoAuditEventRecord[] {
    return filterAuditEvents([...this.auditEvents.values()], filter).map(cloneJson);
  }

  revokeProofCapsule(
    capsuleId: string,
    reason: string,
    now: string = new Date().toISOString(),
    revokedBy?: DojoAuditActor,
    evidenceRefs: string[] = []
  ): DojoProofCapsuleRecord | null {
    const record = this.proofRecords.get(capsuleId);
    if (!record) return null;
    const revocationEvidenceRefs = compactUniqueStrings(evidenceRefs);
    const revoked = {
      ...record,
      status: "revoked" as const,
      revoked_at: now,
      revoked_reason: reason,
      revoked_by: revokedBy ? cloneJson(revokedBy) : record.revoked_by,
      ...(revocationEvidenceRefs.length ? { revocation_evidence_refs: revocationEvidenceRefs } : {}),
    };
    this.proofRecords.set(capsuleId, cloneJson(revoked));
    return cloneJson(revoked);
  }

  clear(): void {
    this.skills.clear();
    this.workflowIndex.clear();
    this.toolIndex.clear();
    this.proofRecords.clear();
    this.permissionUpgradeRequests.clear();
    this.caseLawRecords.clear();
    this.ghostShadowEvidence.clear();
    this.auditEvents.clear();
  }

  private removeToolIndexesForSkill(skillId: string): void {
    for (const [toolName, indexedSkillId] of this.toolIndex.entries()) {
      if (indexedSkillId === skillId) this.toolIndex.delete(toolName);
    }
  }
}

export interface EncryptedFileDojoSkillStoreOptions {
  file_path: string;
  key: string;
  scope_id?: string;
}

interface PersistedDojoScope {
  skills: Record<string, DojoSkill>;
  workflow_index: Record<string, string>;
  published_tool_index: Record<string, string>;
  proof_records: Record<string, DojoProofCapsuleRecord>;
  permission_upgrade_requests: Record<string, DojoPermissionUpgradeRequestRecord>;
  case_law_records: Record<string, DojoCaseLawRecord>;
  ghost_shadow_evidence: Record<string, DojoGhostShadowEvidenceRecord>;
  audit_events: Record<string, DojoAuditEventRecord>;
}

interface EncryptedDojoStoreDocument {
  schema_version: "synthi_dojo_store_v1";
  scopes: Record<string, PersistedDojoScope>;
}

interface EncryptedDojoStoreEnvelope {
  schema_version: "synthi_dojo_store_envelope_v1";
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

const DOJO_STORE_FILE_MODE = 0o600;

export class EncryptedFileDojoSkillStore implements DojoControlPlaneStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer;
  private readonly scopeId: string;

  constructor(options: EncryptedFileDojoSkillStoreOptions) {
    if (!options.file_path.trim()) throw new Error("dojo_store_file_required");
    if (!options.key.trim()) throw new Error("dojo_store_key_required");
    this.filePath = options.file_path;
    this.encryptionKey = createHash("sha256").update(options.key, "utf8").digest();
    this.scopeId = normalizeScopeId(options.scope_id);
  }

  saveSkill(skill: DojoSkill): void {
    this.updateScope((scope) => {
      const clone = cloneJson(skill);
      scope.skills[clone.skill_id] = clone;
      scope.workflow_index[clone.workflow_id] = clone.skill_id;
      removeToolIndexesForSkill(scope.published_tool_index, clone.skill_id);
      for (const toolName of publishedToolNamesForSkill(clone)) {
        scope.published_tool_index[toolName] = clone.skill_id;
      }
    });
  }

  getSkill(skillId: string): DojoSkill | null {
    const skill = this.scope().skills[skillId];
    return skill ? cloneJson(skill) : null;
  }

  getSkillByWorkflowId(workflowId: string): DojoSkill | null {
    const scope = this.scope();
    const skillId = scope.workflow_index[workflowId];
    const skill = skillId ? scope.skills[skillId] : null;
    return skill ? cloneJson(skill) : null;
  }

  getSkillByPublishedToolName(toolName: string): DojoSkill | null {
    const scope = this.scope();
    const skillId = scope.published_tool_index[toolName];
    const skill = skillId ? scope.skills[skillId] : null;
    return skill ? cloneJson(skill) : null;
  }

  getPublishedWorkflowBindingByWorkflowId(workflowId: string): DojoPublishedWorkflowBinding | null {
    const skill = this.getSkillByWorkflowId(workflowId);
    return skill ? publishedWorkflowBindingForSkill(skill) : null;
  }

  getPublishedWorkflowBindingByToolName(toolName: string): DojoPublishedWorkflowBinding | null {
    const skill = this.getSkillByPublishedToolName(toolName);
    return skill ? publishedWorkflowBindingForSkill(skill) : null;
  }

  listSkills(): DojoSkill[] {
    return Object.values(this.scope().skills).map(cloneJson);
  }

  saveProofRecord(record: DojoProofCapsuleRecord): void {
    this.updateScope((scope) => {
      scope.proof_records[record.capsule_id] = cloneJson(record);
    });
  }

  getProofRecord(capsuleId: string): DojoProofCapsuleRecord | null {
    const record = this.scope().proof_records[capsuleId];
    return record ? cloneJson(record) : null;
  }

  listProofRecords(): DojoProofCapsuleRecord[] {
    return Object.values(this.scope().proof_records).map(cloneJson);
  }

  markProofCapsuleValidated(capsuleId: string, now: string = new Date().toISOString()): DojoProofCapsuleRecord | null {
    let validated: DojoProofCapsuleRecord | null = null;
    this.updateScope((scope) => {
      const record = scope.proof_records[capsuleId];
      if (!record) return;
      validated = {
        ...record,
        last_validated_at: now,
      };
      scope.proof_records[capsuleId] = cloneJson(validated);
    });
    return validated ? cloneJson(validated) : null;
  }

  markProofCapsuleUsed(capsuleId: string, runId: string, now: string = new Date().toISOString()): DojoProofConsumeResult {
    let result: DojoProofConsumeResult | null = null;
    this.updateScope((scope) => {
      const record = scope.proof_records[capsuleId];
      if (!record) {
        result = proofConsumeBlocked(null, "missing", "proof_capsule_not_issued_by_registry");
        return;
      }
      if (record.status === "revoked") {
        result = proofConsumeBlocked(record, "revoked", "proof_capsule_revoked");
        return;
      }
      if (record.status === "used") {
        result = proofConsumeBlocked(record, "already_used", "proof_capsule_replay_detected");
        return;
      }
      const used = {
        ...record,
        status: "used" as const,
        first_used_at: record.first_used_at ?? now,
        last_validated_at: now,
      };
      scope.proof_records[capsuleId] = cloneJson(used);
      const audit = auditEventRecordFromInput(proofUseAuditEventInput(used, runId, now));
      scope.audit_events[audit.audit_event_id] = cloneJson(audit);
      result = { ok: true, record: cloneJson(used), status: "used", blocked_by: [] };
    });
    return result ?? proofConsumeBlocked(null, "missing", "proof_capsule_not_issued_by_registry");
  }

  savePermissionUpgradeRequest(record: DojoPermissionUpgradeRequestRecord): void {
    this.updateScope((scope) => {
      scope.permission_upgrade_requests[record.request_id] = cloneJson(record);
    });
  }

  listPermissionUpgradeRequests(filter: DojoPermissionUpgradeRequestFilter = {}): DojoPermissionUpgradeRequestRecord[] {
    return filterPermissionUpgradeRequests(Object.values(this.scope().permission_upgrade_requests), filter).map(cloneJson);
  }

  saveCaseLawRecord(record: DojoCaseLawRecord): void {
    this.updateScope((scope) => {
      scope.case_law_records[record.case_id] = cloneJson(record);
    });
  }

  getCaseLawRecord(caseId: string): DojoCaseLawRecord | null {
    const record = this.scope().case_law_records[caseId];
    return record ? cloneJson(record) : null;
  }

  listCaseLawRecords(filter: DojoCaseLawRecordFilter = {}): DojoCaseLawRecord[] {
    return filterCaseLawRecords(Object.values(this.scope().case_law_records), filter).map(cloneJson);
  }

  saveGhostShadowEvidence(record: DojoGhostShadowEvidenceRecord): void {
    this.updateScope((scope) => {
      scope.ghost_shadow_evidence[record.evidence_id] = cloneJson(record);
    });
  }

  listGhostShadowEvidence(filter: DojoGhostShadowEvidenceFilter = {}): DojoGhostShadowEvidenceRecord[] {
    return filterGhostShadowEvidence(Object.values(this.scope().ghost_shadow_evidence), filter).map(cloneJson);
  }

  appendAuditEvent(event: DojoAuditEventInput): DojoAuditEventRecord {
    const record = auditEventRecordFromInput(event);
    this.updateScope((scope) => {
      if (scope.audit_events[record.audit_event_id]) throw new Error("dojo_audit_event_already_exists");
      scope.audit_events[record.audit_event_id] = cloneJson(record);
    });
    return cloneJson(record);
  }

  listAuditEvents(filter: DojoAuditEventListFilter = {}): DojoAuditEventRecord[] {
    return filterAuditEvents(Object.values(this.scope().audit_events), filter).map(cloneJson);
  }

  revokeProofCapsule(
    capsuleId: string,
    reason: string,
    now: string = new Date().toISOString(),
    revokedBy?: DojoAuditActor,
    evidenceRefs: string[] = []
  ): DojoProofCapsuleRecord | null {
    let revoked: DojoProofCapsuleRecord | null = null;
    this.updateScope((scope) => {
      const record = scope.proof_records[capsuleId];
      if (!record) return;
      const revocationEvidenceRefs = compactUniqueStrings(evidenceRefs);
      revoked = {
        ...record,
        status: "revoked",
        revoked_at: now,
        revoked_reason: reason,
        revoked_by: revokedBy ? cloneJson(revokedBy) : record.revoked_by,
        ...(revocationEvidenceRefs.length ? { revocation_evidence_refs: revocationEvidenceRefs } : {}),
      };
      scope.proof_records[capsuleId] = cloneJson(revoked);
    });
    return revoked ? cloneJson(revoked) : null;
  }

  clear(): void {
    const document = this.readDocument();
    document.scopes[this.scopeId] = emptyScope();
    this.writeDocument(document);
  }

  private scope(): PersistedDojoScope {
    const document = this.readDocument();
    return cloneScope(document.scopes[this.scopeId] ?? emptyScope());
  }

  private updateScope(mutator: (scope: PersistedDojoScope) => void): void {
    const document = this.readDocument();
    const scope = cloneScope(document.scopes[this.scopeId] ?? emptyScope());
    mutator(scope);
    document.scopes[this.scopeId] = scope;
    this.writeDocument(document);
  }

  private readDocument(): EncryptedDojoStoreDocument {
    if (!existsSync(this.filePath)) return emptyDocument();
    let envelope: EncryptedDojoStoreEnvelope;
    try {
      envelope = JSON.parse(readFileSync(this.filePath, "utf8")) as EncryptedDojoStoreEnvelope;
      if (
        envelope.schema_version !== "synthi_dojo_store_envelope_v1" ||
        envelope.algorithm !== "aes-256-gcm" ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) {
        throw new Error("invalid_dojo_store_envelope");
      }
    } catch (err) {
      if (err instanceof Error && err.message === "invalid_dojo_store_envelope") throw err;
      throw new Error("dojo_store_parse_failed");
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const document = JSON.parse(plaintext) as EncryptedDojoStoreDocument;
      if (document.schema_version !== "synthi_dojo_store_v1" || typeof document.scopes !== "object") {
        throw new Error("invalid_dojo_store_document");
      }
      return normalizeDocument(document);
    } catch {
      throw new Error("dojo_store_decrypt_failed");
    }
  }

  private writeDocument(document: EncryptedDojoStoreDocument): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(normalizeDocument(document)), "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedDojoStoreEnvelope = {
      schema_version: "synthi_dojo_store_envelope_v1",
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const tempPath = path.join(directory, `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      writeFileSync(tempPath, JSON.stringify(envelope), { encoding: "utf8", mode: DOJO_STORE_FILE_MODE });
      renameSync(tempPath, this.filePath);
      chmodSync(this.filePath, DOJO_STORE_FILE_MODE);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }
}

export function createDefaultDojoSkillStore(env: NodeJS.ProcessEnv = process.env): DojoControlPlaneStore {
  const filePath = env["SYNTHI_DOJO_STORE_FILE"]?.trim();
  const key = env["SYNTHI_DOJO_STORE_KEY"]?.trim();
  if (!filePath && !key) return new InMemoryDojoSkillStore();
  if (!filePath || !key) throw new Error("dojo_store_file_and_key_required");
  return new EncryptedFileDojoSkillStore({
    file_path: filePath,
    key,
    scope_id: env["SYNTHI_DOJO_STORE_SCOPE"],
  });
}

function emptyDocument(): EncryptedDojoStoreDocument {
  return { schema_version: "synthi_dojo_store_v1", scopes: {} };
}

function emptyScope(): PersistedDojoScope {
  return {
    skills: {},
    workflow_index: {},
    published_tool_index: {},
    proof_records: {},
    permission_upgrade_requests: {},
    case_law_records: {},
    ghost_shadow_evidence: {},
    audit_events: {},
  };
}

function cloneScope(scope: PersistedDojoScope): PersistedDojoScope {
  return {
    skills: Object.fromEntries(Object.entries(scope.skills ?? {}).map(([key, value]) => [key, cloneJson(value)])),
    workflow_index: { ...(scope.workflow_index ?? {}) },
    published_tool_index: { ...(scope.published_tool_index ?? {}) },
    proof_records: Object.fromEntries(Object.entries(scope.proof_records ?? {}).map(([key, value]) => [key, cloneJson(value)])),
    permission_upgrade_requests: Object.fromEntries(
      Object.entries(scope.permission_upgrade_requests ?? {}).map(([key, value]) => [key, cloneJson(value)])
    ),
    case_law_records: Object.fromEntries(
      Object.entries(scope.case_law_records ?? {}).map(([key, value]) => [key, cloneJson(value)])
    ),
    ghost_shadow_evidence: Object.fromEntries(
      Object.entries(scope.ghost_shadow_evidence ?? {}).map(([key, value]) => [key, cloneJson(value)])
    ),
    audit_events: Object.fromEntries(
      Object.entries(scope.audit_events ?? {}).map(([key, value]) => [key, cloneJson(value)])
    ),
  };
}

function normalizeDocument(document: EncryptedDojoStoreDocument): EncryptedDojoStoreDocument {
  return {
    schema_version: "synthi_dojo_store_v1",
    scopes: Object.fromEntries(Object.entries(document.scopes ?? {}).map(([scopeId, scope]) => [
      normalizeScopeId(scopeId),
      cloneScope(scope),
    ])),
  };
}

function normalizeScopeId(scopeId: string | undefined): string {
  const trimmed = scopeId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function compactUniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function auditEventRecordFromInput(event: DojoAuditEventInput): DojoAuditEventRecord {
  const createdAt = event.created_at ?? new Date().toISOString();
  return {
    tenant_id: event.tenant_id,
    workspace_id: event.workspace_id,
    audit_event_id: event.audit_event_id ?? `audit_${randomBytes(16).toString("hex")}`,
    actor: cloneJson(event.actor),
    event_type: event.event_type,
    request_id: event.request_id,
    correlation_id: event.correlation_id,
    ...(event.entity_kind ? { entity_kind: event.entity_kind } : {}),
    ...(event.entity_id ? { entity_id: event.entity_id } : {}),
    details: cloneJson(event.details ?? {}),
    created_at: createdAt,
  };
}

function proofUseAuditEventInput(record: DojoProofCapsuleRecord, runId: string, now: string): DojoAuditEventInput {
  return {
    tenant_id: record.tenant_id ?? "legacy-local-tenant",
    workspace_id: record.workspace_id ?? "legacy-local-workspace",
    actor: record.issued_by ?? { actor_id: "dojo-proof-store", actor_type: "service" },
    event_type: "proof_used",
    request_id: `proof-used-${record.capsule_id}`,
    correlation_id: `proof-${record.skill_id}-${record.capsule_id}`,
    entity_kind: "proof_capsule",
    entity_id: record.capsule_id,
    created_at: now,
    details: {
      skill_id: record.skill_id,
      requested_action: record.requested_action,
      run_id: runId,
      license_id: record.license_id,
      license_version: record.license_version,
      proof_status: record.status,
      substrate_claim: record.substrate_claim,
    },
  };
}

function proofConsumeBlocked(
  record: DojoProofCapsuleRecord | null,
  status: DojoProofConsumeResult["status"],
  reason: string
): DojoProofConsumeResult {
  return {
    ok: false,
    record: record ? cloneJson(record) : null,
    status,
    blocked_by: [reason],
  };
}

function removeToolIndexesForSkill(index: Record<string, string>, skillId: string): void {
  for (const [toolName, indexedSkillId] of Object.entries(index)) {
    if (indexedSkillId === skillId) delete index[toolName];
  }
}

function filterPermissionUpgradeRequests(
  records: DojoPermissionUpgradeRequestRecord[],
  filter: DojoPermissionUpgradeRequestFilter
): DojoPermissionUpgradeRequestRecord[] {
  const limit = Number.isFinite(filter.limit) && typeof filter.limit === "number" && filter.limit > 0
    ? Math.floor(filter.limit)
    : undefined;
  const filtered = records
    .filter((record) => !filter.request_id || record.request_id === filter.request_id)
    .filter((record) => !filter.skill_id || record.skill_id === filter.skill_id)
    .filter((record) => !filter.workflow_id || record.workflow_id === filter.workflow_id)
    .filter((record) => !filter.requested_action || record.requested_action === filter.requested_action)
    .filter((record) => !filter.status || record.status === filter.status)
    .sort((left, right) => right.requested_at.localeCompare(left.requested_at) || left.request_id.localeCompare(right.request_id));
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function filterCaseLawRecords(
  records: DojoCaseLawRecord[],
  filter: DojoCaseLawRecordFilter
): DojoCaseLawRecord[] {
  const limit = Number.isFinite(filter.limit) && typeof filter.limit === "number" && filter.limit > 0
    ? Math.floor(filter.limit)
    : undefined;
  const filtered = records
    .filter((record) => !filter.case_id || record.case_id === filter.case_id)
    .filter((record) => !filter.status || record.status === filter.status)
    .filter((record) =>
      !filter.binding_scope
        || (record.binding_scope.kind === filter.binding_scope.kind && record.binding_scope.id === filter.binding_scope.id)
    )
    .filter((record) => !filter.applies_to || record.applies_to.includes(filter.applies_to))
    .sort((left, right) => left.binding_scope.kind.localeCompare(right.binding_scope.kind)
      || left.binding_scope.id.localeCompare(right.binding_scope.id)
      || left.case_id.localeCompare(right.case_id));
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function filterGhostShadowEvidence(
  records: DojoGhostShadowEvidenceRecord[],
  filter: DojoGhostShadowEvidenceFilter
): DojoGhostShadowEvidenceRecord[] {
  const limit = Number.isFinite(filter.limit) && typeof filter.limit === "number" && filter.limit > 0
    ? Math.floor(filter.limit)
    : undefined;
  const filtered = records
    .filter((record) => !filter.evidence_id || record.evidence_id === filter.evidence_id)
    .filter((record) => !filter.run_id || record.run_id === filter.run_id)
    .filter((record) => !filter.skill_id || record.skill_id === filter.skill_id)
    .filter((record) => !filter.workflow_id || record.workflow_id === filter.workflow_id)
    .filter((record) => typeof filter.action_matches !== "boolean" || record.action_matches === filter.action_matches)
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || left.evidence_id.localeCompare(right.evidence_id));
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}

function filterAuditEvents(
  records: DojoAuditEventRecord[],
  filter: DojoAuditEventListFilter
): DojoAuditEventRecord[] {
  const limit = Number.isFinite(filter.limit) && typeof filter.limit === "number" && filter.limit > 0
    ? Math.floor(filter.limit)
    : undefined;
  const filtered = records
    .filter((record) => !filter.event_type || record.event_type === filter.event_type)
    .filter((record) => !filter.entity_kind || record.entity_kind === filter.entity_kind)
    .filter((record) => !filter.entity_id || record.entity_id === filter.entity_id)
    .filter((record) => !filter.correlation_id || record.correlation_id === filter.correlation_id)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.audit_event_id.localeCompare(right.audit_event_id));
  return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
}
