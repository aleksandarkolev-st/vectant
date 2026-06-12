import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DojoTenantContext } from "../mcp/execution_policy_gate.js";
import type {
  DojoAuditEventRecord,
  DojoAuditStore,
  MaybePromise,
} from "../store/interfaces.js";

export type DojoHostedRuntimeActionKind =
  | "snapshot"
  | "teach"
  | "control"
  | "workflow_replay"
  | "graph_action"
  | "proof_gated_tool";

export type DojoHostedRuntimeSessionStatus = "active" | "revoked" | "expired";

export type DojoHostedRuntimeBlockCode =
  | "runtime_origin_allowlist_required"
  | "runtime_skill_binding_required"
  | "runtime_run_binding_required"
  | "runtime_workspace_url_invalid"
  | "runtime_workspace_origin_not_allowed"
  | "runtime_session_ttl_invalid"
  | "runtime_session_ttl_too_long"
  | "runtime_credential_ttl_invalid"
  | "runtime_screenshot_redaction_required"
  | "runtime_session_not_found"
  | "runtime_tenant_mismatch"
  | "runtime_workspace_mismatch"
  | "runtime_skill_mismatch"
  | "runtime_run_mismatch"
  | "runtime_session_expired"
  | "runtime_session_revoked"
  | "runtime_credential_missing"
  | "runtime_credential_invalid"
  | "runtime_credential_expired"
  | "runtime_action_url_invalid"
  | "runtime_origin_not_allowed"
  | "runtime_local_network_blocked"
  | "runtime_evidence_writer_missing"
  | "runtime_evidence_write_failed";

export interface DojoHostedRuntimeCredential {
  credential_id: string;
  credential_secret: string;
  expires_at: string;
}

export interface DojoHostedRuntimeSessionRecord {
  schema_version: "synthi.dojo.hostedRuntimeSession.v1";
  session_id: string;
  runtime_id: string;
  tenant_id: string;
  organization_id: string;
  workspace_id: string;
  skill_id: string;
  run_id: string;
  actor_id: string;
  actor_type: DojoTenantContext["actor_type"];
  workspace_url: string;
  workspace_origin: string;
  origin_allowlist: string[];
  status: DojoHostedRuntimeSessionStatus;
  created_at: string;
  expires_at: string;
  revoked_at?: string;
  revoked_reason?: string;
  credential_id: string;
  credential_sha256: string;
  credential_expires_at: string;
  egress_policy: {
    local_network_allowed: boolean;
  };
  redaction_policy: {
    screenshots: boolean;
  };
  audit_event_refs: string[];
  evidence_refs: string[];
}

export interface DojoHostedRuntimeSessionStore {
  saveSession(record: DojoHostedRuntimeSessionRecord): MaybePromise<DojoHostedRuntimeSessionRecord>;
  getSession(input: {
    tenant_id: string;
    workspace_id: string;
    session_id: string;
  }): MaybePromise<DojoHostedRuntimeSessionRecord | null>;
  updateSession(record: DojoHostedRuntimeSessionRecord): MaybePromise<DojoHostedRuntimeSessionRecord>;
  listSessions(input: {
    tenant_id: string;
    workspace_id: string;
    skill_id?: string;
    run_id?: string;
  }): MaybePromise<DojoHostedRuntimeSessionRecord[]>;
}

export interface DojoHostedRuntimeEvidenceWriter {
  appendRuntimeActionEvidence(input: {
    tenant: DojoTenantContext;
    session: DojoHostedRuntimeSessionRecord;
    action_kind: DojoHostedRuntimeActionKind;
    url: string;
    url_origin: string;
    created_at: string;
    details?: Record<string, unknown>;
  }): MaybePromise<{ record_id: string; evidence_ref?: string }>;
}

export interface DojoHostedRuntimeGateway {
  createSession(input: DojoHostedRuntimeCreateSessionInput): Promise<DojoHostedRuntimeCreateSessionResult>;
  authorizeAction(input: DojoHostedRuntimeAuthorizeActionInput): Promise<DojoHostedRuntimeActionDecision>;
  revokeSession(input: DojoHostedRuntimeRevokeSessionInput): Promise<DojoHostedRuntimeRevokeSessionResult>;
}

export interface DojoHostedRuntimeCreateSessionInput {
  tenant: DojoTenantContext;
  skill_id: string;
  run_id: string;
  workspace_url: string;
  runtime_id?: string;
  session_id?: string;
  origin_allowlist: string[];
  ttl_ms?: number;
  credential_ttl_ms?: number;
  local_network_allowed?: boolean;
  redact_screenshots?: boolean;
  sensitive_workspace?: boolean;
  now?: string;
}

export type DojoHostedRuntimeCreateSessionResult =
  | {
    ok: true;
    session: DojoHostedRuntimeSessionRecord;
    credentials: DojoHostedRuntimeCredential;
    audit_event_id: string;
  }
  | {
    ok: false;
    blocked_by: DojoHostedRuntimeBlockCode[];
    audit_event_id: string;
  };

export interface DojoHostedRuntimeAuthorizeActionInput {
  tenant: DojoTenantContext;
  session_id: string;
  skill_id: string;
  run_id: string;
  action_kind: DojoHostedRuntimeActionKind;
  url: string;
  credential_id?: string;
  credential_secret?: string;
  now?: string;
  details?: Record<string, unknown>;
}

export interface DojoHostedRuntimeActionDecision {
  ok: boolean;
  status: "authorized" | "blocked";
  session_id: string;
  action_kind: DojoHostedRuntimeActionKind;
  blocked_by: DojoHostedRuntimeBlockCode[];
  audit_event_id: string;
  evidence_record_ids: string[];
}

export interface DojoHostedRuntimeRevokeSessionInput {
  tenant: DojoTenantContext;
  session_id: string;
  reason: string;
  now?: string;
}

export type DojoHostedRuntimeRevokeSessionResult =
  | {
    ok: true;
    status: "revoked";
    session: DojoHostedRuntimeSessionRecord;
    audit_event_id: string;
  }
  | {
    ok: false;
    blocked_by: DojoHostedRuntimeBlockCode[];
    audit_event_id: string;
  };

export interface InProcessDojoHostedRuntimeGatewayOptions {
  audit_store: DojoAuditStore;
  store?: DojoHostedRuntimeSessionStore;
  evidence_writer?: DojoHostedRuntimeEvidenceWriter;
  now?: () => Date;
  random_id?: () => string;
  random_secret?: () => string;
  default_session_ttl_ms?: number;
  default_credential_ttl_ms?: number;
  max_session_ttl_ms?: number;
}

const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CREDENTIAL_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_TTL_MS = 60 * 60 * 1000;

export function createInProcessDojoHostedRuntimeGateway(
  options: InProcessDojoHostedRuntimeGatewayOptions
): DojoHostedRuntimeGateway {
  return new InProcessDojoHostedRuntimeGateway(options);
}

export class InMemoryDojoHostedRuntimeSessionStore implements DojoHostedRuntimeSessionStore {
  private readonly sessions = new Map<string, DojoHostedRuntimeSessionRecord>();

  saveSession(record: DojoHostedRuntimeSessionRecord): DojoHostedRuntimeSessionRecord {
    this.sessions.set(sessionKey(record.tenant_id, record.workspace_id, record.session_id), cloneSession(record));
    return cloneSession(record);
  }

  getSession(input: { tenant_id: string; workspace_id: string; session_id: string }): DojoHostedRuntimeSessionRecord | null {
    const record = this.sessions.get(sessionKey(input.tenant_id, input.workspace_id, input.session_id));
    return record ? cloneSession(record) : null;
  }

  updateSession(record: DojoHostedRuntimeSessionRecord): DojoHostedRuntimeSessionRecord {
    this.sessions.set(sessionKey(record.tenant_id, record.workspace_id, record.session_id), cloneSession(record));
    return cloneSession(record);
  }

  listSessions(input: {
    tenant_id: string;
    workspace_id: string;
    skill_id?: string;
    run_id?: string;
  }): DojoHostedRuntimeSessionRecord[] {
    return [...this.sessions.values()]
      .filter((session) => session.tenant_id === input.tenant_id)
      .filter((session) => session.workspace_id === input.workspace_id)
      .filter((session) => !input.skill_id || session.skill_id === input.skill_id)
      .filter((session) => !input.run_id || session.run_id === input.run_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.session_id.localeCompare(b.session_id))
      .map(cloneSession);
  }
}

class InProcessDojoHostedRuntimeGateway implements DojoHostedRuntimeGateway {
  private readonly auditStore: DojoAuditStore;
  private readonly store: DojoHostedRuntimeSessionStore;
  private readonly evidenceWriter?: DojoHostedRuntimeEvidenceWriter;
  private readonly nowFn: () => Date;
  private readonly randomId: () => string;
  private readonly randomSecret: () => string;
  private readonly defaultSessionTtlMs: number;
  private readonly defaultCredentialTtlMs: number;
  private readonly maxSessionTtlMs: number;

  constructor(options: InProcessDojoHostedRuntimeGatewayOptions) {
    this.auditStore = options.audit_store;
    this.store = options.store ?? new InMemoryDojoHostedRuntimeSessionStore();
    this.evidenceWriter = options.evidence_writer;
    this.nowFn = options.now ?? (() => new Date());
    this.randomId = options.random_id ?? (() => randomUUID());
    this.randomSecret = options.random_secret ?? (() => randomBytes(32).toString("base64url"));
    this.defaultSessionTtlMs = options.default_session_ttl_ms ?? DEFAULT_SESSION_TTL_MS;
    this.defaultCredentialTtlMs = options.default_credential_ttl_ms ?? DEFAULT_CREDENTIAL_TTL_MS;
    this.maxSessionTtlMs = options.max_session_ttl_ms ?? MAX_SESSION_TTL_MS;
  }

  async createSession(input: DojoHostedRuntimeCreateSessionInput): Promise<DojoHostedRuntimeCreateSessionResult> {
    const now = this.resolveNow(input.now);
    const tenant = input.tenant;
    const workspaceOrigin = originForUrl(input.workspace_url);
    const originAllowlist = normalizeDojoHostedRuntimeOriginAllowlist(input.origin_allowlist);
    const blockedBy: DojoHostedRuntimeBlockCode[] = [];
    const sessionTtlMs = input.ttl_ms ?? this.defaultSessionTtlMs;
    const credentialTtlMs = input.credential_ttl_ms ?? Math.min(this.defaultCredentialTtlMs, sessionTtlMs);
    const skillId = typeof input.skill_id === "string" ? input.skill_id.trim() : "";
    const runId = typeof input.run_id === "string" ? input.run_id.trim() : "";

    if (!skillId) blockedBy.push("runtime_skill_binding_required");
    if (!runId) blockedBy.push("runtime_run_binding_required");
    if (!workspaceOrigin) blockedBy.push("runtime_workspace_url_invalid");
    if (originAllowlist.length === 0) blockedBy.push("runtime_origin_allowlist_required");
    if (workspaceOrigin && originAllowlist.length > 0 && !originAllowlist.includes(workspaceOrigin)) {
      blockedBy.push("runtime_workspace_origin_not_allowed");
    }
    if (!Number.isInteger(sessionTtlMs) || sessionTtlMs <= 0) blockedBy.push("runtime_session_ttl_invalid");
    if (sessionTtlMs > this.maxSessionTtlMs) blockedBy.push("runtime_session_ttl_too_long");
    if (!Number.isInteger(credentialTtlMs) || credentialTtlMs <= 0 || credentialTtlMs > sessionTtlMs) {
      blockedBy.push("runtime_credential_ttl_invalid");
    }
    if (input.sensitive_workspace && input.redact_screenshots === false) {
      blockedBy.push("runtime_screenshot_redaction_required");
    }

    if (blockedBy.length > 0 || !workspaceOrigin) {
      const audit = await this.appendAudit({
        tenant,
        event_type: "runtime_session_rejected",
        entity_kind: "runtime_session",
        entity_id: input.session_id,
        created_at: now.toISOString(),
        details: {
          skill_id: input.skill_id,
          run_id: input.run_id,
          workspace_url: input.workspace_url,
          blocked_by: blockedBy,
        },
      });
      return { ok: false, blocked_by: blockedBy, audit_event_id: audit.audit_event_id };
    }

    const sessionId = input.session_id ?? `dojo_runtime_session_${this.randomId()}`;
    const runtimeId = input.runtime_id ?? `dojo_runtime_${this.randomId()}`;
    const credentialId = `runtime_cred_${this.randomId()}`;
    const credentialSecret = this.randomSecret();
    const session: DojoHostedRuntimeSessionRecord = {
      schema_version: "synthi.dojo.hostedRuntimeSession.v1",
      session_id: sessionId,
      runtime_id: runtimeId,
      tenant_id: tenant.tenant_id,
      organization_id: tenant.organization_id,
      workspace_id: tenant.workspace_id,
      skill_id: skillId,
      run_id: runId,
      actor_id: tenant.actor_id,
      actor_type: tenant.actor_type,
      workspace_url: input.workspace_url,
      workspace_origin: workspaceOrigin,
      origin_allowlist: originAllowlist,
      status: "active",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + sessionTtlMs).toISOString(),
      credential_id: credentialId,
      credential_sha256: hashCredential(credentialId, credentialSecret),
      credential_expires_at: new Date(now.getTime() + credentialTtlMs).toISOString(),
      egress_policy: {
        local_network_allowed: input.local_network_allowed === true,
      },
      redaction_policy: {
        screenshots: input.redact_screenshots !== false,
      },
      audit_event_refs: [],
      evidence_refs: [],
    };

    const audit = await this.appendAudit({
      tenant,
      event_type: "runtime_session_created",
      entity_kind: "runtime_session",
      entity_id: session.session_id,
      created_at: session.created_at,
      details: {
        runtime_id: session.runtime_id,
        skill_id: session.skill_id,
        run_id: session.run_id,
        workspace_origin: session.workspace_origin,
        credential_expires_at: session.credential_expires_at,
        expires_at: session.expires_at,
      },
    });
    const saved = await this.store.saveSession({
      ...session,
      audit_event_refs: [audit.audit_event_id],
    });

    return {
      ok: true,
      session: saved,
      credentials: {
        credential_id: credentialId,
        credential_secret: credentialSecret,
        expires_at: session.credential_expires_at,
      },
      audit_event_id: audit.audit_event_id,
    };
  }

  async authorizeAction(input: DojoHostedRuntimeAuthorizeActionInput): Promise<DojoHostedRuntimeActionDecision> {
    const now = this.resolveNow(input.now);
    const tenant = input.tenant;
    const session = await this.store.getSession({
      tenant_id: tenant.tenant_id,
      workspace_id: tenant.workspace_id,
      session_id: input.session_id,
    });

    if (!session) {
      return this.blockAction(input, ["runtime_session_not_found"], now.toISOString());
    }

    const blockedBy = this.evaluateSessionAction(session, input, now);
    if (blockedBy.length > 0) {
      const updated = await this.persistExpiredSessionIfNeeded(session, blockedBy, now);
      return this.blockAction(input, blockedBy, now.toISOString(), updated);
    }

    if (!this.evidenceWriter) {
      return this.blockAction(input, ["runtime_evidence_writer_missing"], now.toISOString(), session);
    }

    const actionOrigin = originForUrl(input.url);
    if (!actionOrigin) {
      return this.blockAction(input, ["runtime_action_url_invalid"], now.toISOString(), session);
    }

    let evidenceId: string;
    try {
      const evidence = await this.evidenceWriter.appendRuntimeActionEvidence({
        tenant,
        session,
        action_kind: input.action_kind,
        url: input.url,
        url_origin: actionOrigin,
        created_at: now.toISOString(),
        details: input.details,
      });
      evidenceId = evidence.evidence_ref ?? evidence.record_id;
    } catch {
      return this.blockAction(input, ["runtime_evidence_write_failed"], now.toISOString(), session);
    }

    const audit = await this.appendAudit({
      tenant,
      event_type: "runtime_action_authorized",
      entity_kind: "runtime_session",
      entity_id: session.session_id,
      created_at: now.toISOString(),
      details: {
        skill_id: session.skill_id,
        run_id: session.run_id,
        action_kind: input.action_kind,
        url_origin: actionOrigin,
        evidence_refs: [evidenceId],
      },
    });
    await this.store.updateSession({
      ...session,
      audit_event_refs: [...session.audit_event_refs, audit.audit_event_id],
      evidence_refs: [...session.evidence_refs, evidenceId],
    });

    return {
      ok: true,
      status: "authorized",
      session_id: session.session_id,
      action_kind: input.action_kind,
      blocked_by: [],
      audit_event_id: audit.audit_event_id,
      evidence_record_ids: [evidenceId],
    };
  }

  async revokeSession(input: DojoHostedRuntimeRevokeSessionInput): Promise<DojoHostedRuntimeRevokeSessionResult> {
    const now = this.resolveNow(input.now);
    const tenant = input.tenant;
    const session = await this.store.getSession({
      tenant_id: tenant.tenant_id,
      workspace_id: tenant.workspace_id,
      session_id: input.session_id,
    });
    if (!session) {
      const audit = await this.appendAudit({
        tenant,
        event_type: "runtime_action_blocked",
        entity_kind: "runtime_session",
        entity_id: input.session_id,
        created_at: now.toISOString(),
        details: {
          blocked_by: ["runtime_session_not_found"],
          attempted_action: "revoke_session",
        },
      });
      return { ok: false, blocked_by: ["runtime_session_not_found"], audit_event_id: audit.audit_event_id };
    }

    const revoked: DojoHostedRuntimeSessionRecord = {
      ...session,
      status: "revoked",
      revoked_at: session.revoked_at ?? now.toISOString(),
      revoked_reason: session.revoked_reason ?? requiredString(input.reason, "reason"),
    };
    const audit = await this.appendAudit({
      tenant,
      event_type: "runtime_session_revoked",
      entity_kind: "runtime_session",
      entity_id: revoked.session_id,
      created_at: now.toISOString(),
      details: {
        skill_id: revoked.skill_id,
        run_id: revoked.run_id,
        reason: revoked.revoked_reason,
      },
    });
    const saved = await this.store.updateSession({
      ...revoked,
      audit_event_refs: [...revoked.audit_event_refs, audit.audit_event_id],
    });
    return {
      ok: true,
      status: "revoked",
      session: saved,
      audit_event_id: audit.audit_event_id,
    };
  }

  private evaluateSessionAction(
    session: DojoHostedRuntimeSessionRecord,
    input: DojoHostedRuntimeAuthorizeActionInput,
    now: Date
  ): DojoHostedRuntimeBlockCode[] {
    const blockedBy: DojoHostedRuntimeBlockCode[] = [];
    if (session.tenant_id !== input.tenant.tenant_id) blockedBy.push("runtime_tenant_mismatch");
    if (session.workspace_id !== input.tenant.workspace_id) blockedBy.push("runtime_workspace_mismatch");
    if (session.skill_id !== input.skill_id) blockedBy.push("runtime_skill_mismatch");
    if (session.run_id !== input.run_id) blockedBy.push("runtime_run_mismatch");
    if (session.status === "revoked") blockedBy.push("runtime_session_revoked");
    if (session.status === "expired" || Date.parse(session.expires_at) <= now.getTime()) blockedBy.push("runtime_session_expired");
    if (!input.credential_id || !input.credential_secret) {
      blockedBy.push("runtime_credential_missing");
    } else if (input.credential_id !== session.credential_id) {
      blockedBy.push("runtime_credential_invalid");
    } else if (hashCredential(input.credential_id, input.credential_secret) !== session.credential_sha256) {
      blockedBy.push("runtime_credential_invalid");
    } else if (Date.parse(session.credential_expires_at) <= now.getTime()) {
      blockedBy.push("runtime_credential_expired");
    }

    const actionOrigin = originForUrl(input.url);
    if (!actionOrigin) {
      blockedBy.push("runtime_action_url_invalid");
    } else {
      if (!session.origin_allowlist.includes(actionOrigin)) blockedBy.push("runtime_origin_not_allowed");
      if (!session.egress_policy.local_network_allowed && isLocalNetworkUrl(input.url)) {
        blockedBy.push("runtime_local_network_blocked");
      }
    }

    return [...new Set(blockedBy)];
  }

  private async persistExpiredSessionIfNeeded(
    session: DojoHostedRuntimeSessionRecord,
    blockedBy: DojoHostedRuntimeBlockCode[],
    now: Date
  ): Promise<DojoHostedRuntimeSessionRecord> {
    if (!blockedBy.includes("runtime_session_expired") || session.status !== "active") return session;
    return this.store.updateSession({
      ...session,
      status: "expired",
      revoked_at: now.toISOString(),
      revoked_reason: "expired",
    });
  }

  private async blockAction(
    input: DojoHostedRuntimeAuthorizeActionInput,
    blockedBy: DojoHostedRuntimeBlockCode[],
    createdAt: string,
    session?: DojoHostedRuntimeSessionRecord
  ): Promise<DojoHostedRuntimeActionDecision> {
    const audit = await this.appendAudit({
      tenant: input.tenant,
      event_type: "runtime_action_blocked",
      entity_kind: "runtime_session",
      entity_id: input.session_id,
      created_at: createdAt,
      details: {
        skill_id: input.skill_id,
        run_id: input.run_id,
        action_kind: input.action_kind,
        url_origin: originForUrl(input.url),
        blocked_by: blockedBy,
        session_status: session?.status,
      },
    });
    if (session) {
      await this.store.updateSession({
        ...session,
        audit_event_refs: [...session.audit_event_refs, audit.audit_event_id],
      });
    }
    return {
      ok: false,
      status: "blocked",
      session_id: input.session_id,
      action_kind: input.action_kind,
      blocked_by: blockedBy,
      audit_event_id: audit.audit_event_id,
      evidence_record_ids: [],
    };
  }

  private async appendAudit(input: {
    tenant: DojoTenantContext;
    event_type: DojoAuditEventRecord["event_type"];
    entity_kind: string;
    entity_id?: string;
    details: Record<string, unknown>;
    created_at: string;
  }): Promise<DojoAuditEventRecord> {
    return this.auditStore.appendAuditEvent({
      tenant_id: input.tenant.tenant_id,
      workspace_id: input.tenant.workspace_id,
      actor: {
        actor_id: input.tenant.actor_id,
        actor_type: input.tenant.actor_type,
      },
      event_type: input.event_type,
      request_id: input.tenant.request_id,
      correlation_id: input.tenant.correlation_id,
      entity_kind: input.entity_kind,
      entity_id: input.entity_id,
      details: {
        organization_id: input.tenant.organization_id,
        ...input.details,
      },
      created_at: input.created_at,
    });
  }

  private resolveNow(value: string | undefined): Date {
    if (!value) return this.nowFn();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("dojo_hosted_runtime_now_invalid");
    return parsed;
  }
}

export function normalizeDojoHostedRuntimeOriginAllowlist(values: string[]): string[] {
  return [...new Set(values.map(originForUrl).filter((value): value is string => Boolean(value)))].sort();
}

function originForUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLocalNetworkUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "[::1]" || host === "0.0.0.0" || host === "::" || host === "[::]") {
      return true;
    }
    if (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.")) return true;
    const match = host.match(/^172\.(\d+)\./);
    return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  } catch {
    return false;
  }
}

function hashCredential(credentialId: string, credentialSecret: string): string {
  return createHash("sha256").update(`${credentialId}:${credentialSecret}`).digest("hex");
}

function requiredString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`dojo_hosted_runtime_${field}_required`);
  return trimmed;
}

function sessionKey(tenantId: string, workspaceId: string, sessionId: string): string {
  return `${tenantId}\u0000${workspaceId}\u0000${sessionId}`;
}

function cloneSession(record: DojoHostedRuntimeSessionRecord): DojoHostedRuntimeSessionRecord {
  return {
    ...record,
    origin_allowlist: [...record.origin_allowlist],
    egress_policy: { ...record.egress_policy },
    redaction_policy: { ...record.redaction_policy },
    audit_event_refs: [...record.audit_event_refs],
    evidence_refs: [...record.evidence_refs],
  };
}
