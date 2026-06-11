import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DojoSkill } from "./dojo.js";
import { publishedToolNamesForSkill, publishedWorkflowBindingForSkill, type DojoPublishedWorkflowBinding } from "../dojo/store/published_workflow_index.js";

export interface DojoProofCapsuleRecord {
  capsule_id: string;
  skill_id: string;
  requested_action: string;
  nonce?: string;
  issued_at: string;
  expires_at: string;
  status: "issued" | "used" | "revoked";
  first_used_at?: string;
  last_validated_at?: string;
  revoked_at?: string;
  revoked_reason?: string;
}

export interface DojoSkillStore {
  saveSkill(skill: DojoSkill): void;
  getSkill(skillId: string): DojoSkill | null;
  getSkillByWorkflowId(workflowId: string): DojoSkill | null;
  getSkillByPublishedToolName(toolName: string): DojoSkill | null;
  getPublishedWorkflowBindingByWorkflowId(workflowId: string): DojoPublishedWorkflowBinding | null;
  getPublishedWorkflowBindingByToolName(toolName: string): DojoPublishedWorkflowBinding | null;
  listSkills(): DojoSkill[];
  saveProofRecord(record: DojoProofCapsuleRecord): void;
  getProofRecord(capsuleId: string): DojoProofCapsuleRecord | null;
  listProofRecords(): DojoProofCapsuleRecord[];
  revokeProofCapsule(capsuleId: string, reason: string, now?: string): DojoProofCapsuleRecord | null;
  clear(): void;
}

export class InMemoryDojoSkillStore implements DojoSkillStore {
  private readonly skills = new Map<string, DojoSkill>();
  private readonly workflowIndex = new Map<string, string>();
  private readonly toolIndex = new Map<string, string>();
  private readonly proofRecords = new Map<string, DojoProofCapsuleRecord>();

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

  revokeProofCapsule(capsuleId: string, reason: string, now: string = new Date().toISOString()): DojoProofCapsuleRecord | null {
    const record = this.proofRecords.get(capsuleId);
    if (!record) return null;
    const revoked = {
      ...record,
      status: "revoked" as const,
      revoked_at: now,
      revoked_reason: reason,
    };
    this.proofRecords.set(capsuleId, cloneJson(revoked));
    return cloneJson(revoked);
  }

  clear(): void {
    this.skills.clear();
    this.workflowIndex.clear();
    this.toolIndex.clear();
    this.proofRecords.clear();
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

export class EncryptedFileDojoSkillStore implements DojoSkillStore {
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

  revokeProofCapsule(capsuleId: string, reason: string, now: string = new Date().toISOString()): DojoProofCapsuleRecord | null {
    let revoked: DojoProofCapsuleRecord | null = null;
    this.updateScope((scope) => {
      const record = scope.proof_records[capsuleId];
      if (!record) return;
      revoked = {
        ...record,
        status: "revoked",
        revoked_at: now,
        revoked_reason: reason,
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

export function createDefaultDojoSkillStore(env: NodeJS.ProcessEnv = process.env): DojoSkillStore {
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
  return { skills: {}, workflow_index: {}, published_tool_index: {}, proof_records: {} };
}

function cloneScope(scope: PersistedDojoScope): PersistedDojoScope {
  return {
    skills: Object.fromEntries(Object.entries(scope.skills ?? {}).map(([key, value]) => [key, cloneJson(value)])),
    workflow_index: { ...(scope.workflow_index ?? {}) },
    published_tool_index: { ...(scope.published_tool_index ?? {}) },
    proof_records: Object.fromEntries(Object.entries(scope.proof_records ?? {}).map(([key, value]) => [key, cloneJson(value)])),
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

function removeToolIndexesForSkill(index: Record<string, string>, skillId: string): void {
  for (const [toolName, indexedSkillId] of Object.entries(index)) {
    if (indexedSkillId === skillId) delete index[toolName];
  }
}
