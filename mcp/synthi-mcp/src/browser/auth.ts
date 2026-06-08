import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizeOrigin } from "./security.js";
import type { AuthDurabilityV7 } from "./workflow.js";

export type AuthCheckpointDurability = Extract<AuthDurabilityV7, "interactiveCheckpoint" | "idpCheckpoint">;

export interface AuthCheckpointEnrollment {
  enrollment_id: string;
  app_origin: string;
  started_at: number;
  reason?: string;
}

export interface AuthCheckpointMetadata {
  checkpoint_id: string;
  app_origin: string;
  idp_origins: string[];
  durability: AuthDurabilityV7;
  created_at: number;
  expires_at: number;
  revoked_at?: number;
  status: "valid" | "expired" | "revoked";
  unattended_allowed: boolean;
  cookie_domain_audit: {
    app_origin: string;
    idp_origin_count: number;
    has_third_party_idp: boolean;
  };
}

export interface AuthRefreshProviderMetadata {
  provider_id: string;
  app_origin: string;
  provider_type: "projectRefreshProvider" | "ciTestAuth";
  secret_ref: string;
  configured_at: number;
  last_tested_at?: number;
  status: "configured" | "validated" | "failed" | "revoked";
  failure_class?: "missingSecretRef" | "providerUnavailable" | "unknown";
}

export interface AuthReadiness {
  ready: boolean;
  durability: AuthDurabilityV7 | "missing";
  status: "ready" | "checkpointMissing" | "checkpointExpired" | "checkpointRevoked" | "unattendedBlocked";
  checkpoint?: AuthCheckpointMetadata;
  refresh_provider?: AuthRefreshProviderMetadata;
  notes: string[];
}

export interface AuthCheckpointStore {
  saveEnrollment(enrollment: AuthCheckpointEnrollment): void;
  getEnrollment(enrollment_id: string): AuthCheckpointEnrollment | null;
  deleteEnrollment(enrollment_id: string): void;
  saveCheckpoint(checkpoint: AuthCheckpointMetadata): void;
  getCheckpoint(checkpoint_id: string): AuthCheckpointMetadata | null;
  listCheckpoints(): AuthCheckpointMetadata[];
  saveRefreshProvider(provider: AuthRefreshProviderMetadata): void;
  getRefreshProvider(provider_id: string): AuthRefreshProviderMetadata | null;
  listRefreshProviders(): AuthRefreshProviderMetadata[];
  clear(): void;
}

export class InMemoryAuthCheckpointStore implements AuthCheckpointStore {
  private readonly enrollments = new Map<string, AuthCheckpointEnrollment>();
  private readonly checkpoints = new Map<string, AuthCheckpointMetadata>();
  private readonly refreshProviders = new Map<string, AuthRefreshProviderMetadata>();

  saveEnrollment(enrollment: AuthCheckpointEnrollment): void {
    this.enrollments.set(enrollment.enrollment_id, { ...enrollment });
  }

  getEnrollment(enrollment_id: string): AuthCheckpointEnrollment | null {
    const enrollment = this.enrollments.get(enrollment_id);
    return enrollment ? { ...enrollment } : null;
  }

  deleteEnrollment(enrollment_id: string): void {
    this.enrollments.delete(enrollment_id);
  }

  saveCheckpoint(checkpoint: AuthCheckpointMetadata): void {
    this.checkpoints.set(checkpoint.checkpoint_id, cloneCheckpointMetadata(checkpoint));
  }

  getCheckpoint(checkpoint_id: string): AuthCheckpointMetadata | null {
    const checkpoint = this.checkpoints.get(checkpoint_id);
    return checkpoint ? cloneCheckpointMetadata(checkpoint) : null;
  }

  listCheckpoints(): AuthCheckpointMetadata[] {
    return [...this.checkpoints.values()].map(cloneCheckpointMetadata);
  }

  saveRefreshProvider(provider: AuthRefreshProviderMetadata): void {
    this.refreshProviders.set(provider.provider_id, { ...provider });
  }

  getRefreshProvider(provider_id: string): AuthRefreshProviderMetadata | null {
    const provider = this.refreshProviders.get(provider_id);
    return provider ? { ...provider } : null;
  }

  listRefreshProviders(): AuthRefreshProviderMetadata[] {
    return [...this.refreshProviders.values()].map((provider) => ({ ...provider }));
  }

  clear(): void {
    this.enrollments.clear();
    this.checkpoints.clear();
    this.refreshProviders.clear();
  }
}

export interface EncryptedFileAuthCheckpointStoreOptions {
  file_path: string;
  key: string;
  scope_id?: string;
}

interface PersistedAuthScope {
  enrollments: Record<string, AuthCheckpointEnrollment>;
  checkpoints: Record<string, AuthCheckpointMetadata>;
  refreshProviders: Record<string, AuthRefreshProviderMetadata>;
}

interface EncryptedAuthStoreDocument {
  schema_version: "synthi_auth_checkpoint_store_v1";
  scopes: Record<string, PersistedAuthScope>;
}

interface EncryptedAuthStoreEnvelope {
  schema_version: "synthi_auth_checkpoint_store_envelope_v1";
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export class EncryptedFileAuthCheckpointStore implements AuthCheckpointStore {
  private readonly filePath: string;
  private readonly encryptionKey: Buffer;
  private readonly scopeId: string;

  constructor(options: EncryptedFileAuthCheckpointStoreOptions) {
    if (!options.file_path.trim()) throw new Error("auth_checkpoint_store_file_required");
    if (!options.key.trim()) throw new Error("auth_checkpoint_store_key_required");
    this.filePath = options.file_path;
    this.encryptionKey = createHash("sha256").update(options.key, "utf8").digest();
    this.scopeId = normalizeScopeId(options.scope_id);
  }

  saveEnrollment(enrollment: AuthCheckpointEnrollment): void {
    this.updateScope((scope) => {
      scope.enrollments[enrollment.enrollment_id] = { ...enrollment };
    });
  }

  getEnrollment(enrollment_id: string): AuthCheckpointEnrollment | null {
    const enrollment = this.scope().enrollments[enrollment_id];
    return enrollment ? { ...enrollment } : null;
  }

  deleteEnrollment(enrollment_id: string): void {
    this.updateScope((scope) => {
      delete scope.enrollments[enrollment_id];
    });
  }

  saveCheckpoint(checkpoint: AuthCheckpointMetadata): void {
    this.updateScope((scope) => {
      scope.checkpoints[checkpoint.checkpoint_id] = cloneCheckpointMetadata(checkpoint);
    });
  }

  getCheckpoint(checkpoint_id: string): AuthCheckpointMetadata | null {
    const checkpoint = this.scope().checkpoints[checkpoint_id];
    return checkpoint ? cloneCheckpointMetadata(checkpoint) : null;
  }

  listCheckpoints(): AuthCheckpointMetadata[] {
    return Object.values(this.scope().checkpoints).map(cloneCheckpointMetadata);
  }

  saveRefreshProvider(provider: AuthRefreshProviderMetadata): void {
    this.updateScope((scope) => {
      scope.refreshProviders[provider.provider_id] = { ...provider };
    });
  }

  getRefreshProvider(provider_id: string): AuthRefreshProviderMetadata | null {
    const provider = this.scope().refreshProviders[provider_id];
    return provider ? { ...provider } : null;
  }

  listRefreshProviders(): AuthRefreshProviderMetadata[] {
    return Object.values(this.scope().refreshProviders).map((provider) => ({ ...provider }));
  }

  clear(): void {
    const document = this.readDocument();
    document.scopes[this.scopeId] = emptyPersistedScope();
    this.writeDocument(document);
  }

  private scope(): PersistedAuthScope {
    const document = this.readDocument();
    return clonePersistedScope(document.scopes[this.scopeId] ?? emptyPersistedScope());
  }

  private updateScope(mutator: (scope: PersistedAuthScope) => void): void {
    const document = this.readDocument();
    const scope = clonePersistedScope(document.scopes[this.scopeId] ?? emptyPersistedScope());
    mutator(scope);
    document.scopes[this.scopeId] = scope;
    this.writeDocument(document);
  }

  private readDocument(): EncryptedAuthStoreDocument {
    if (!existsSync(this.filePath)) return emptyEncryptedAuthStoreDocument();
    let envelope: EncryptedAuthStoreEnvelope;
    try {
      envelope = JSON.parse(readFileSync(this.filePath, "utf8")) as EncryptedAuthStoreEnvelope;
      if (
        envelope.schema_version !== "synthi_auth_checkpoint_store_envelope_v1" ||
        envelope.algorithm !== "aes-256-gcm" ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      ) {
        throw new Error("invalid_auth_checkpoint_store_envelope");
      }
    } catch (err) {
      if (err instanceof Error && err.message === "invalid_auth_checkpoint_store_envelope") throw err;
      throw new Error("auth_checkpoint_store_parse_failed");
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const document = JSON.parse(plaintext) as EncryptedAuthStoreDocument;
      if (document.schema_version !== "synthi_auth_checkpoint_store_v1" || typeof document.scopes !== "object") {
        throw new Error("invalid_auth_checkpoint_store_document");
      }
      return normalizeDocument(document);
    } catch {
      throw new Error("auth_checkpoint_store_decrypt_failed");
    }
  }

  private writeDocument(document: EncryptedAuthStoreDocument): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(normalizeDocument(document)), "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedAuthStoreEnvelope = {
      schema_version: "synthi_auth_checkpoint_store_envelope_v1",
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    writeFileSync(this.filePath, JSON.stringify(envelope), "utf8");
  }
}

export class AuthCheckpointManager {
  constructor(private readonly store: AuthCheckpointStore = new InMemoryAuthCheckpointStore()) {}

  beginEnrollment(url: string, reason?: string): AuthCheckpointEnrollment {
    const enrollment: AuthCheckpointEnrollment = {
      enrollment_id: `auth_enroll_${randomUUID()}`,
      app_origin: normalizeOrigin(url).origin,
      started_at: Date.now(),
      reason,
    };
    this.store.saveEnrollment(enrollment);
    return { ...enrollment };
  }

  finishEnrollment(input: {
    enrollment_id: string;
    app_url?: string;
    redirect_chain?: string[];
    ttl_ms?: number;
    durability?: AuthCheckpointDurability;
  }): { ok: true; checkpoint: AuthCheckpointMetadata } | { ok: false; error: string } {
    const enrollment = this.store.getEnrollment(input.enrollment_id);
    if (!enrollment) return { ok: false, error: "auth_enrollment_not_found" };
    const appOrigin = normalizeOrigin(input.app_url ?? enrollment.app_origin).origin;
    if (appOrigin !== enrollment.app_origin) return { ok: false, error: "auth_enrollment_origin_mismatch" };
    const now = Date.now();
    const ttl = clampTtl(input.ttl_ms);
    const idpOrigins = [...new Set((input.redirect_chain ?? [])
      .map((url) => safeOrigin(url))
      .filter((origin): origin is string => origin !== null && origin !== appOrigin))];
    const durability = checkpointDurabilityOpt(input.durability) ?? (idpOrigins.length > 0 ? "idpCheckpoint" : "interactiveCheckpoint");
    const checkpoint: AuthCheckpointMetadata = {
      checkpoint_id: `auth_ckpt_${randomUUID()}`,
      app_origin: appOrigin,
      idp_origins: idpOrigins,
      durability,
      created_at: now,
      expires_at: now + ttl,
      status: "valid",
      unattended_allowed: false,
      cookie_domain_audit: {
        app_origin: appOrigin,
        idp_origin_count: idpOrigins.length,
        has_third_party_idp: idpOrigins.length > 0,
      },
    };
    this.store.deleteEnrollment(input.enrollment_id);
    this.store.saveCheckpoint(checkpoint);
    return { ok: true, checkpoint: { ...checkpoint, idp_origins: [...checkpoint.idp_origins] } };
  }

  list(url?: string): AuthCheckpointMetadata[] {
    const origin = url ? normalizeOrigin(url).origin : null;
    return this.store.listCheckpoints()
      .filter((checkpoint) => !origin || checkpoint.app_origin === origin)
      .map((checkpoint) => this.snapshot(checkpoint));
  }

  revoke(checkpoint_id: string): { ok: true; checkpoint: AuthCheckpointMetadata } | { ok: false; error: string } {
    const checkpoint = this.store.getCheckpoint(checkpoint_id);
    if (!checkpoint) return { ok: false, error: "auth_checkpoint_not_found" };
    checkpoint.revoked_at = Date.now();
    checkpoint.status = "revoked";
    checkpoint.unattended_allowed = false;
    this.store.saveCheckpoint(checkpoint);
    return { ok: true, checkpoint: this.snapshot(checkpoint) };
  }

  configureRefreshProvider(input: {
    url: string;
    secret_ref: string;
    provider_type?: AuthRefreshProviderMetadata["provider_type"];
  }): { ok: true; provider: AuthRefreshProviderMetadata } | { ok: false; error: string } {
    if (!isSecretRef(input.secret_ref)) return { ok: false, error: "auth_refresh_provider_secret_ref_required" };
    const provider: AuthRefreshProviderMetadata = {
      provider_id: `auth_refresh_${randomUUID()}`,
      app_origin: normalizeOrigin(input.url).origin,
      provider_type: input.provider_type ?? "projectRefreshProvider",
      secret_ref: input.secret_ref,
      configured_at: Date.now(),
      status: "configured",
    };
    this.store.saveRefreshProvider(provider);
    return { ok: true, provider: this.snapshotProvider(provider) };
  }

  testRefreshProvider(provider_id: string): { ok: true; provider: AuthRefreshProviderMetadata; can_mint_replay_state: boolean } | { ok: false; error: string } {
    const provider = this.store.getRefreshProvider(provider_id);
    if (!provider) return { ok: false, error: "auth_refresh_provider_not_found" };
    provider.last_tested_at = Date.now();
    if (!isSecretRef(provider.secret_ref)) {
      provider.status = "failed";
      provider.failure_class = "missingSecretRef";
      this.store.saveRefreshProvider(provider);
      return { ok: true, provider: this.snapshotProvider(provider), can_mint_replay_state: false };
    }
    provider.status = "validated";
    delete provider.failure_class;
    this.store.saveRefreshProvider(provider);
    return { ok: true, provider: this.snapshotProvider(provider), can_mint_replay_state: true };
  }

  listRefreshProviders(url?: string): AuthRefreshProviderMetadata[] {
    const origin = url ? normalizeOrigin(url).origin : null;
    return this.store.listRefreshProviders()
      .filter((provider) => !origin || provider.app_origin === origin)
      .map((provider) => this.snapshotProvider(provider));
  }

  readiness(url: string, unattended: boolean = false): AuthReadiness {
    const origin = normalizeOrigin(url).origin;
    const provider = this.store.listRefreshProviders()
      .filter((candidate) => candidate.app_origin === origin && candidate.status !== "revoked")
      .sort((a, b) => b.configured_at - a.configured_at)[0];
    if (unattended && provider?.status === "validated") {
      return {
        ready: true,
        durability: provider.provider_type === "ciTestAuth" ? "ciTestAuth" : "refreshProvider",
        status: "ready",
        refresh_provider: this.snapshotProvider(provider),
        notes: ["Refresh provider can mint replay auth for unattended runs."],
      };
    }
    const checkpoint = this.store.listCheckpoints()
      .filter((candidate) => candidate.app_origin === origin)
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!checkpoint) {
      return {
        ready: false,
        durability: "missing",
        status: "checkpointMissing",
        notes: ["No auth checkpoint is enrolled for this origin."],
      };
    }
    const snapshot = this.snapshot(checkpoint);
    if (snapshot.status === "revoked") {
      return {
        ready: false,
        durability: snapshot.durability,
        status: "checkpointRevoked",
        checkpoint: snapshot,
        notes: ["Auth checkpoint was revoked."],
      };
    }
    if (snapshot.status === "expired") {
      return {
        ready: false,
        durability: snapshot.durability,
        status: "checkpointExpired",
        checkpoint: snapshot,
        notes: ["Auth checkpoint expired and must be renewed."],
      };
    }
    if (unattended && !snapshot.unattended_allowed) {
      return {
        ready: false,
        durability: snapshot.durability,
        status: "unattendedBlocked",
        checkpoint: snapshot,
        ...(provider ? { refresh_provider: this.snapshotProvider(provider) } : {}),
        notes: provider
          ? ["Refresh provider exists but must validate before unattended replay."]
          : ["Unattended runs require refreshProvider or ciTestAuth durability."],
      };
    }
    return {
      ready: true,
      durability: snapshot.durability,
      status: "ready",
      checkpoint: snapshot,
      ...(provider ? { refresh_provider: this.snapshotProvider(provider) } : {}),
      notes: unattended
        ? ["Auth checkpoint is durable for unattended replay."]
        : ["Auth checkpoint is ready for interactive replay."],
    };
  }

  resetForTests(): void {
    this.store.clear();
  }

  private snapshot(checkpoint: AuthCheckpointMetadata): AuthCheckpointMetadata {
    const status = checkpoint.status === "revoked"
      ? "revoked"
      : checkpoint.expires_at <= Date.now() ? "expired" : "valid";
    return {
      ...checkpoint,
      status,
      idp_origins: [...checkpoint.idp_origins],
      cookie_domain_audit: { ...checkpoint.cookie_domain_audit },
    };
  }

  private snapshotProvider(provider: AuthRefreshProviderMetadata): AuthRefreshProviderMetadata {
    return { ...provider };
  }
}

function checkpointDurabilityOpt(value: unknown): AuthCheckpointDurability | undefined {
  if (value === "interactiveCheckpoint" || value === "idpCheckpoint") return value;
  return undefined;
}

function clampTtl(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 24 * 60 * 60 * 1000;
  return Math.min(Math.max(value, 1_000), 30 * 24 * 60 * 60 * 1000);
}

function safeOrigin(url: string): string | null {
  try {
    return normalizeOrigin(url).origin;
  } catch {
    return null;
  }
}

function isSecretRef(value: string): boolean {
  return /^synthi:\/\/secrets\/[A-Za-z0-9_.:/-]+$/.test(value);
}

function cloneCheckpointMetadata(checkpoint: AuthCheckpointMetadata): AuthCheckpointMetadata {
  return {
    ...checkpoint,
    idp_origins: [...checkpoint.idp_origins],
    cookie_domain_audit: { ...checkpoint.cookie_domain_audit },
  };
}

export function createDefaultAuthCheckpointStore(env: NodeJS.ProcessEnv = process.env): AuthCheckpointStore {
  const filePath = env["SYNTHI_AUTH_CHECKPOINT_STORE_FILE"]?.trim();
  const key = env["SYNTHI_AUTH_CHECKPOINT_STORE_KEY"]?.trim();
  if (!filePath && !key) return new InMemoryAuthCheckpointStore();
  if (!filePath || !key) throw new Error("auth_checkpoint_store_file_and_key_required");
  return new EncryptedFileAuthCheckpointStore({
    file_path: filePath,
    key,
    scope_id: env["SYNTHI_AUTH_CHECKPOINT_SCOPE"],
  });
}

function emptyEncryptedAuthStoreDocument(): EncryptedAuthStoreDocument {
  return { schema_version: "synthi_auth_checkpoint_store_v1", scopes: {} };
}

function emptyPersistedScope(): PersistedAuthScope {
  return { enrollments: {}, checkpoints: {}, refreshProviders: {} };
}

function clonePersistedScope(scope: PersistedAuthScope): PersistedAuthScope {
  return {
    enrollments: Object.fromEntries(Object.entries(scope.enrollments ?? {}).map(([key, value]) => [key, { ...value }])),
    checkpoints: Object.fromEntries(Object.entries(scope.checkpoints ?? {}).map(([key, value]) => [key, cloneCheckpointMetadata(value)])),
    refreshProviders: Object.fromEntries(Object.entries(scope.refreshProviders ?? {}).map(([key, value]) => [key, { ...value }])),
  };
}

function normalizeDocument(document: EncryptedAuthStoreDocument): EncryptedAuthStoreDocument {
  return {
    schema_version: "synthi_auth_checkpoint_store_v1",
    scopes: Object.fromEntries(Object.entries(document.scopes ?? {}).map(([scopeId, scope]) => [
      normalizeScopeId(scopeId),
      clonePersistedScope(scope),
    ])),
  };
}

function normalizeScopeId(scopeId: string | undefined): string {
  const trimmed = scopeId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "default";
}

export const authCheckpointManager = new AuthCheckpointManager(createDefaultAuthCheckpointStore());
