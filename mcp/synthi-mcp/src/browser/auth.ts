import { spawnSync } from "node:child_process";
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
  refresh_provider_id?: string;
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
  storage_artifact?: AuthStorageArtifactMetadata;
}

export interface AuthStorageCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  partitionKey?: string;
}

export interface AuthStorageEntry {
  name: string;
  value: string;
}

export interface AuthStorageOriginState {
  origin: string;
  localStorage?: AuthStorageEntry[];
  sessionStorage?: AuthStorageEntry[];
}

export interface AuthBrowserStorageState {
  cookies?: AuthStorageCookie[];
  origins?: AuthStorageOriginState[];
}

export interface AuthStorageArtifactMetadata {
  artifact_id: string;
  checkpoint_id: string;
  app_origin: string;
  origin_count: number;
  cookie_count: number;
  local_storage_entry_count: number;
  session_storage_entry_count: number;
  captured_at: number;
}

export interface AuthStorageArtifact {
  metadata: AuthStorageArtifactMetadata;
  state: {
    cookies: AuthStorageCookie[];
    origins: AuthStorageOriginState[];
  };
}

export interface AuthRefreshProviderCommand {
  command: string;
  working_directory?: string;
  timeout_ms: number;
}

export interface AuthRefreshProviderMetadata {
  provider_id: string;
  app_origin: string;
  provider_type: "projectRefreshProvider" | "ciTestAuth";
  secret_ref: string;
  mint_command?: AuthRefreshProviderCommand;
  mint_command_configured?: boolean;
  configured_at: number;
  last_tested_at?: number;
  last_minted_at?: number;
  last_mint_artifact?: AuthStorageArtifactMetadata;
  status: "configured" | "validated" | "failed" | "revoked";
  failure_class?: "missingSecretRef" | "missingMintCommand" | "invalidMintCommand" | "mintCommandFailed" | "invalidMintResult" | "providerUnavailable" | "unknown";
}

export interface AuthReadiness {
  ready: boolean;
  durability: AuthDurabilityV7 | "missing";
  status: "ready" | "checkpointMissing" | "checkpointExpired" | "checkpointRevoked" | "checkpointStorageMissing" | "unattendedBlocked";
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
  saveStorageArtifact(artifact: AuthStorageArtifact): void;
  getStorageArtifact(artifact_id: string): AuthStorageArtifact | null;
  deleteStorageArtifact(artifact_id: string): void;
  saveRefreshProvider(provider: AuthRefreshProviderMetadata): void;
  getRefreshProvider(provider_id: string): AuthRefreshProviderMetadata | null;
  listRefreshProviders(): AuthRefreshProviderMetadata[];
  clear(): void;
}

export class InMemoryAuthCheckpointStore implements AuthCheckpointStore {
  private readonly enrollments = new Map<string, AuthCheckpointEnrollment>();
  private readonly checkpoints = new Map<string, AuthCheckpointMetadata>();
  private readonly storageArtifacts = new Map<string, AuthStorageArtifact>();
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

  saveStorageArtifact(artifact: AuthStorageArtifact): void {
    this.storageArtifacts.set(artifact.metadata.artifact_id, cloneStorageArtifact(artifact));
  }

  getStorageArtifact(artifact_id: string): AuthStorageArtifact | null {
    const artifact = this.storageArtifacts.get(artifact_id);
    return artifact ? cloneStorageArtifact(artifact) : null;
  }

  deleteStorageArtifact(artifact_id: string): void {
    this.storageArtifacts.delete(artifact_id);
  }

  saveRefreshProvider(provider: AuthRefreshProviderMetadata): void {
    this.refreshProviders.set(provider.provider_id, cloneRefreshProvider(provider));
  }

  getRefreshProvider(provider_id: string): AuthRefreshProviderMetadata | null {
    const provider = this.refreshProviders.get(provider_id);
    return provider ? cloneRefreshProvider(provider) : null;
  }

  listRefreshProviders(): AuthRefreshProviderMetadata[] {
    return [...this.refreshProviders.values()].map(cloneRefreshProvider);
  }

  clear(): void {
    this.enrollments.clear();
    this.checkpoints.clear();
    this.storageArtifacts.clear();
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
  storageArtifacts: Record<string, AuthStorageArtifact>;
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

  saveStorageArtifact(artifact: AuthStorageArtifact): void {
    this.updateScope((scope) => {
      scope.storageArtifacts[artifact.metadata.artifact_id] = cloneStorageArtifact(artifact);
    });
  }

  getStorageArtifact(artifact_id: string): AuthStorageArtifact | null {
    const artifact = this.scope().storageArtifacts[artifact_id];
    return artifact ? cloneStorageArtifact(artifact) : null;
  }

  deleteStorageArtifact(artifact_id: string): void {
    this.updateScope((scope) => {
      delete scope.storageArtifacts[artifact_id];
    });
  }

  saveRefreshProvider(provider: AuthRefreshProviderMetadata): void {
    this.updateScope((scope) => {
      scope.refreshProviders[provider.provider_id] = cloneRefreshProvider(provider);
    });
  }

  getRefreshProvider(provider_id: string): AuthRefreshProviderMetadata | null {
    const provider = this.scope().refreshProviders[provider_id];
    return provider ? cloneRefreshProvider(provider) : null;
  }

  listRefreshProviders(): AuthRefreshProviderMetadata[] {
    return Object.values(this.scope().refreshProviders).map(cloneRefreshProvider);
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
    if (checkpoint.storage_artifact) {
      this.store.deleteStorageArtifact(checkpoint.storage_artifact.artifact_id);
      delete checkpoint.storage_artifact;
    }
    this.store.saveCheckpoint(checkpoint);
    return { ok: true, checkpoint: this.snapshot(checkpoint) };
  }

  saveStorageArtifact(input: {
    checkpoint_id: string;
    storage_state: AuthBrowserStorageState;
    captured_at?: number;
  }): { ok: true; checkpoint: AuthCheckpointMetadata; storage_artifact: AuthStorageArtifactMetadata } | { ok: false; error: string } {
    const checkpoint = this.store.getCheckpoint(input.checkpoint_id);
    if (!checkpoint) return { ok: false, error: "auth_checkpoint_not_found" };
    const snapshot = this.snapshot(checkpoint);
    if (snapshot.status !== "valid") return { ok: false, error: `auth_checkpoint_${snapshot.status}` };

    if (checkpoint.storage_artifact) {
      this.store.deleteStorageArtifact(checkpoint.storage_artifact.artifact_id);
    }
    const allowedOrigins = [checkpoint.app_origin, ...checkpoint.idp_origins];
    const state = filterStorageStateForOrigins(input.storage_state, allowedOrigins);
    const metadata = storageArtifactMetadata({
      checkpoint_id: checkpoint.checkpoint_id,
      app_origin: checkpoint.app_origin,
      captured_at: input.captured_at ?? Date.now(),
      state,
    });
    const artifact: AuthStorageArtifact = { metadata, state };
    checkpoint.storage_artifact = metadata;
    this.store.saveStorageArtifact(artifact);
    this.store.saveCheckpoint(checkpoint);
    return { ok: true, checkpoint: this.snapshot(checkpoint), storage_artifact: { ...metadata } };
  }

  storageArtifactForCheckpoint(checkpoint_id: string): AuthStorageArtifact | null {
    const checkpoint = this.store.getCheckpoint(checkpoint_id);
    if (!checkpoint?.storage_artifact) return null;
    const artifact = this.store.getStorageArtifact(checkpoint.storage_artifact.artifact_id);
    return artifact ? cloneStorageArtifact(artifact) : null;
  }

  configureRefreshProvider(input: {
    url: string;
    secret_ref: string;
    provider_type?: AuthRefreshProviderMetadata["provider_type"];
    mint_command?: string;
    working_directory?: string;
    timeout_ms?: number;
  }): { ok: true; provider: AuthRefreshProviderMetadata } | { ok: false; error: string } {
    if (!isSecretRef(input.secret_ref)) return { ok: false, error: "auth_refresh_provider_secret_ref_required" };
    const mintCommand = normalizeRefreshProviderCommand(input);
    if (!mintCommand.ok) return { ok: false, error: mintCommand.error };
    const provider: AuthRefreshProviderMetadata = {
      provider_id: `auth_refresh_${randomUUID()}`,
      app_origin: normalizeOrigin(input.url).origin,
      provider_type: input.provider_type ?? "projectRefreshProvider",
      secret_ref: input.secret_ref,
      ...(mintCommand.command ? { mint_command: mintCommand.command } : {}),
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
    if (!provider.mint_command?.command.trim()) {
      provider.status = "failed";
      provider.failure_class = "missingMintCommand";
      this.store.saveRefreshProvider(provider);
      return { ok: true, provider: this.snapshotProvider(provider), can_mint_replay_state: false };
    }
    const minted = runRefreshProviderCommand(provider);
    if (!minted.ok) {
      provider.status = "failed";
      provider.failure_class = minted.failure_class;
      this.store.saveRefreshProvider(provider);
      return { ok: true, provider: this.snapshotProvider(provider), can_mint_replay_state: false };
    }
    const saved = this.saveMintedRefreshProviderCheckpoint(provider, minted.output);
    if (!saved.ok) {
      provider.status = "failed";
      provider.failure_class = "invalidMintResult";
      this.store.saveRefreshProvider(provider);
      return { ok: true, provider: this.snapshotProvider(provider), can_mint_replay_state: false };
    }
    provider.status = "validated";
    provider.last_minted_at = saved.storage_artifact.captured_at;
    provider.last_mint_artifact = saved.storage_artifact;
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
    const providers = this.store.listRefreshProviders()
      .filter((candidate) => candidate.app_origin === origin && candidate.status !== "revoked")
      .sort((a, b) => b.configured_at - a.configured_at);
    const provider = providers[0];
    const readyProvider = providers
      .filter((candidate) => this.refreshProviderHasUsableMint(candidate))
      .sort((a, b) => (b.last_minted_at ?? b.configured_at) - (a.last_minted_at ?? a.configured_at))[0];
    if (unattended && readyProvider) {
      return {
        ready: true,
        durability: readyProvider.provider_type === "ciTestAuth" ? "ciTestAuth" : "refreshProvider",
        status: "ready",
        refresh_provider: this.snapshotProvider(readyProvider),
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
    if (!snapshot.storage_artifact) {
      return {
        ready: false,
        durability: snapshot.durability,
        status: "checkpointStorageMissing",
        checkpoint: snapshot,
        ...(provider ? { refresh_provider: this.snapshotProvider(provider) } : {}),
        notes: ["Auth checkpoint is missing a captured browser storage artifact."],
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
    const snapshot = cloneRefreshProvider(provider);
    delete snapshot.mint_command;
    snapshot.mint_command_configured = Boolean(provider.mint_command?.command.trim());
    if (snapshot.last_mint_artifact) snapshot.last_mint_artifact = { ...snapshot.last_mint_artifact };
    return snapshot;
  }

  private refreshProviderHasUsableMint(provider: AuthRefreshProviderMetadata): boolean {
    if (provider.status !== "validated" || !provider.last_mint_artifact) return false;
    const checkpoint = this.store.getCheckpoint(provider.last_mint_artifact.checkpoint_id);
    if (!checkpoint?.storage_artifact) return false;
    return this.snapshot(checkpoint).status === "valid";
  }

  private saveMintedRefreshProviderCheckpoint(
    provider: AuthRefreshProviderMetadata,
    output: AuthRefreshProviderMintOutput
  ): { ok: true; storage_artifact: AuthStorageArtifactMetadata } | { ok: false; error: string } {
    const appOrigin = normalizeOrigin(provider.app_origin).origin;
    const idpOrigins = [...new Set((output.redirect_chain ?? [])
      .map((url) => safeOrigin(url))
      .filter((origin): origin is string => origin !== null && origin !== appOrigin))];
    const now = Date.now();
    const checkpoint: AuthCheckpointMetadata = {
      checkpoint_id: `auth_ckpt_${randomUUID()}`,
      app_origin: appOrigin,
      idp_origins: idpOrigins,
      durability: idpOrigins.length > 0 ? "idpCheckpoint" : "interactiveCheckpoint",
      refresh_provider_id: provider.provider_id,
      created_at: now,
      expires_at: now + clampTtl(output.ttl_ms),
      status: "valid",
      unattended_allowed: true,
      cookie_domain_audit: {
        app_origin: appOrigin,
        idp_origin_count: idpOrigins.length,
        has_third_party_idp: idpOrigins.length > 0,
      },
    };
    this.store.saveCheckpoint(checkpoint);
    const saved = this.saveStorageArtifact({
      checkpoint_id: checkpoint.checkpoint_id,
      storage_state: output.storage_state,
      captured_at: output.captured_at ?? now,
    });
    if (!saved.ok) {
      this.revoke(checkpoint.checkpoint_id);
      return saved;
    }
    if (!hasStoredAuthState(saved.storage_artifact)) {
      this.revoke(checkpoint.checkpoint_id);
      return { ok: false, error: "auth_refresh_provider_empty_storage_state" };
    }
    return { ok: true, storage_artifact: saved.storage_artifact };
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

function normalizeRefreshProviderCommand(input: {
  mint_command?: string;
  working_directory?: string;
  timeout_ms?: number;
}): { ok: true; command?: AuthRefreshProviderCommand } | { ok: false; error: string } {
  if (input.mint_command === undefined) return { ok: true };
  const command = input.mint_command.trim();
  if (command.length === 0) return { ok: false, error: "auth_refresh_provider_mint_command_required" };
  return {
    ok: true,
    command: {
      command,
      ...(input.working_directory?.trim() ? { working_directory: input.working_directory.trim() } : {}),
      timeout_ms: clampCommandTimeout(input.timeout_ms),
    },
  };
}

function clampCommandTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 30_000;
  return Math.min(Math.max(Math.floor(value), 1_000), 120_000);
}

function cloneCheckpointMetadata(checkpoint: AuthCheckpointMetadata): AuthCheckpointMetadata {
  return {
    ...checkpoint,
    idp_origins: [...checkpoint.idp_origins],
    cookie_domain_audit: { ...checkpoint.cookie_domain_audit },
    ...(checkpoint.storage_artifact ? { storage_artifact: { ...checkpoint.storage_artifact } } : {}),
  };
}

function cloneRefreshProvider(provider: AuthRefreshProviderMetadata): AuthRefreshProviderMetadata {
  return {
    ...provider,
    ...(provider.mint_command ? { mint_command: { ...provider.mint_command } } : {}),
    ...(provider.last_mint_artifact ? { last_mint_artifact: { ...provider.last_mint_artifact } } : {}),
  };
}

function cloneStorageArtifact(artifact: AuthStorageArtifact): AuthStorageArtifact {
  return {
    metadata: { ...artifact.metadata },
    state: {
      cookies: artifact.state.cookies.map((cookie) => ({ ...cookie })),
      origins: artifact.state.origins.map((origin) => ({
        origin: origin.origin,
        ...(origin.localStorage ? { localStorage: origin.localStorage.map((entry) => ({ ...entry })) } : {}),
        ...(origin.sessionStorage ? { sessionStorage: origin.sessionStorage.map((entry) => ({ ...entry })) } : {}),
      })),
    },
  };
}

function filterStorageStateForOrigins(
  storageState: AuthBrowserStorageState,
  allowedOrigins: string[]
): AuthStorageArtifact["state"] {
  const normalizedOrigins = [...new Set(allowedOrigins.map((origin) => safeOrigin(origin)).filter((origin): origin is string => origin !== null))];
  const allowedHosts = new Set(normalizedOrigins.map((origin) => new URL(origin).hostname.toLowerCase()));
  const cookies = (storageState.cookies ?? [])
    .filter((cookie) => cookieMatchesAllowedOrigin(cookie, allowedHosts))
    .map(normalizeStorageCookie)
    .filter((cookie): cookie is AuthStorageCookie => cookie !== null);
  const origins = (storageState.origins ?? [])
    .map(normalizeStorageOriginState)
    .filter((origin): origin is AuthStorageOriginState => origin !== null && normalizedOrigins.includes(origin.origin));
  return { cookies, origins };
}

function storageArtifactMetadata(input: {
  checkpoint_id: string;
  app_origin: string;
  captured_at: number;
  state: AuthStorageArtifact["state"];
}): AuthStorageArtifactMetadata {
  return {
    artifact_id: `auth_storage_${randomUUID()}`,
    checkpoint_id: input.checkpoint_id,
    app_origin: input.app_origin,
    origin_count: input.state.origins.length,
    cookie_count: input.state.cookies.length,
    local_storage_entry_count: input.state.origins.reduce((sum, origin) => sum + (origin.localStorage?.length ?? 0), 0),
    session_storage_entry_count: input.state.origins.reduce((sum, origin) => sum + (origin.sessionStorage?.length ?? 0), 0),
    captured_at: input.captured_at,
  };
}

function normalizeStorageCookie(cookie: AuthStorageCookie): AuthStorageCookie | null {
  if (!nonEmpty(cookie.name) || typeof cookie.value !== "string" || !nonEmpty(cookie.domain)) return null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path ?? "/",
    ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {}),
    ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
    ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
    ...(typeof cookie.sameSite === "string" ? { sameSite: cookie.sameSite } : {}),
    ...(typeof cookie.partitionKey === "string" ? { partitionKey: cookie.partitionKey } : {}),
  };
}

function normalizeStorageOriginState(originState: AuthStorageOriginState): AuthStorageOriginState | null {
  const origin = safeOrigin(originState.origin);
  if (!origin) return null;
  return {
    origin,
    localStorage: normalizeStorageEntries(originState.localStorage),
    sessionStorage: normalizeStorageEntries(originState.sessionStorage),
  };
}

function normalizeStorageEntries(entries: AuthStorageEntry[] | undefined): AuthStorageEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => nonEmpty(entry.name) && typeof entry.value === "string")
    .map((entry) => ({ name: entry.name, value: entry.value }));
}

function cookieMatchesAllowedOrigin(cookie: AuthStorageCookie, allowedHosts: Set<string>): boolean {
  const cookieDomain = cookie.domain.replace(/^\./, "").toLowerCase();
  if (!cookieDomain) return false;
  for (const host of allowedHosts) {
    if (host === cookieDomain || host.endsWith(`.${cookieDomain}`)) return true;
  }
  return false;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
  return { enrollments: {}, checkpoints: {}, storageArtifacts: {}, refreshProviders: {} };
}

function clonePersistedScope(scope: PersistedAuthScope): PersistedAuthScope {
  return {
    enrollments: Object.fromEntries(Object.entries(scope.enrollments ?? {}).map(([key, value]) => [key, { ...value }])),
    checkpoints: Object.fromEntries(Object.entries(scope.checkpoints ?? {}).map(([key, value]) => [key, cloneCheckpointMetadata(value)])),
    storageArtifacts: Object.fromEntries(Object.entries(scope.storageArtifacts ?? {}).map(([key, value]) => [key, cloneStorageArtifact(value)])),
    refreshProviders: Object.fromEntries(Object.entries(scope.refreshProviders ?? {}).map(([key, value]) => [key, cloneRefreshProvider(value)])),
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

interface AuthRefreshProviderMintOutput {
  storage_state: AuthBrowserStorageState;
  redirect_chain?: string[];
  ttl_ms?: number;
  captured_at?: number;
}

function runRefreshProviderCommand(
  provider: AuthRefreshProviderMetadata
): { ok: true; output: AuthRefreshProviderMintOutput } | { ok: false; failure_class: NonNullable<AuthRefreshProviderMetadata["failure_class"]> } {
  if (!provider.mint_command) return { ok: false, failure_class: "missingMintCommand" };
  const argv = parseCommandLine(provider.mint_command.command);
  if (!argv || argv.length === 0) return { ok: false, failure_class: "invalidMintCommand" };
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: provider.mint_command.working_directory,
    shell: false,
    encoding: "utf8",
    timeout: provider.mint_command.timeout_ms,
    env: {
      ...process.env,
      SYNTHI_AUTH_APP_ORIGIN: provider.app_origin,
      SYNTHI_AUTH_PROVIDER_ID: provider.provider_id,
      SYNTHI_AUTH_PROVIDER_TYPE: provider.provider_type,
      SYNTHI_AUTH_SECRET_REF: provider.secret_ref,
    },
  });
  if (result.error || result.status !== 0) return { ok: false, failure_class: "mintCommandFailed" };
  return parseRefreshProviderMintOutput(result.stdout);
}

function parseCommandLine(command: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== "\"") {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === "\"" && quote !== "'") {
      quote = quote === "\"" ? null : "\"";
      continue;
    }
    if (/\s/.test(char) && quote === null) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (quote !== null) return null;
  if (current.length > 0) argv.push(current);
  return argv;
}

function parseRefreshProviderMintOutput(
  stdout: string
): { ok: true; output: AuthRefreshProviderMintOutput } | { ok: false; failure_class: "invalidMintResult" } {
  const text = stdout.trim();
  if (text.length === 0) return { ok: false, failure_class: "invalidMintResult" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failure_class: "invalidMintResult" };
  }
  const result = asRecord(parsed);
  if (!result || result["ok"] !== true) return { ok: false, failure_class: "invalidMintResult" };
  const storageState = asRecord(result["storage_state"]);
  if (!storageState) return { ok: false, failure_class: "invalidMintResult" };
  const output: AuthRefreshProviderMintOutput = {
    storage_state: {
      cookies: authStorageCookieArray(storageState["cookies"]),
      origins: authStorageOriginArray(storageState["origins"]),
    },
    redirect_chain: stringArray(result["redirect_chain"]),
    ttl_ms: finiteNumber(result["ttl_ms"]),
    captured_at: finiteNumber(result["captured_at"]),
  };
  if (!hasRawAuthState(output.storage_state)) return { ok: false, failure_class: "invalidMintResult" };
  return { ok: true, output };
}

function hasRawAuthState(storageState: AuthBrowserStorageState): boolean {
  return (storageState.cookies?.length ?? 0) > 0 ||
    (storageState.origins ?? []).some((origin) =>
      (origin.localStorage?.length ?? 0) > 0 || (origin.sessionStorage?.length ?? 0) > 0
    );
}

function hasStoredAuthState(metadata: AuthStorageArtifactMetadata): boolean {
  return metadata.cookie_count + metadata.local_storage_entry_count + metadata.session_storage_entry_count > 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function authStorageCookieArray(value: unknown): AuthStorageCookie[] {
  return Array.isArray(value)
    ? value
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        name: typeof item["name"] === "string" ? item["name"] : "",
        value: typeof item["value"] === "string" ? item["value"] : "",
        domain: typeof item["domain"] === "string" ? item["domain"] : "",
        ...(typeof item["path"] === "string" ? { path: item["path"] } : {}),
        ...(typeof item["expires"] === "number" ? { expires: item["expires"] } : {}),
        ...(typeof item["httpOnly"] === "boolean" ? { httpOnly: item["httpOnly"] } : {}),
        ...(typeof item["secure"] === "boolean" ? { secure: item["secure"] } : {}),
        ...(typeof item["sameSite"] === "string" ? { sameSite: item["sameSite"] } : {}),
        ...(typeof item["partitionKey"] === "string" ? { partitionKey: item["partitionKey"] } : {}),
      }))
      .filter((cookie) => cookie.name.length > 0 && cookie.domain.length > 0)
    : [];
}

function authStorageOriginArray(value: unknown): AuthStorageOriginState[] {
  return Array.isArray(value)
    ? value
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        origin: typeof item["origin"] === "string" ? item["origin"] : "",
        localStorage: authStorageEntryArray(item["localStorage"]),
        sessionStorage: authStorageEntryArray(item["sessionStorage"]),
      }))
      .filter((origin) => origin.origin.length > 0)
    : [];
}

function authStorageEntryArray(value: unknown): AuthStorageEntry[] {
  return Array.isArray(value)
    ? value
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        name: typeof item["name"] === "string" ? item["name"] : "",
        value: typeof item["value"] === "string" ? item["value"] : "",
      }))
      .filter((entry) => entry.name.length > 0)
    : [];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export const authCheckpointManager = new AuthCheckpointManager(createDefaultAuthCheckpointStore());
