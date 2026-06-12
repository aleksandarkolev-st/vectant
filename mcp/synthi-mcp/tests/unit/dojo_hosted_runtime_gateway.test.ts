import { describe, expect, it } from "vitest";
import {
  createInProcessDojoHostedRuntimeGateway,
  InMemoryDojoHostedRuntimeSessionStore,
  normalizeDojoHostedRuntimeOriginAllowlist,
  type DojoHostedRuntimeEvidenceWriter,
} from "../../src/dojo/runtime/hosted_runtime_gateway.js";
import type {
  DojoAuditEventInput,
  DojoAuditEventListFilter,
  DojoAuditEventRecord,
  DojoAuditStore,
} from "../../src/dojo/store/interfaces.js";
import type { DojoTenantContext } from "../../src/dojo/mcp/execution_policy_gate.js";

describe("Dojo hosted runtime gateway", () => {
  it("normalizes origin allowlists by URL origin", () => {
    expect(normalizeDojoHostedRuntimeOriginAllowlist([
      "https://workspace.example.test/a",
      "https://workspace.example.test/b",
      "not-a-url",
      "https://docs.example.test",
    ])).toEqual([
      "https://docs.example.test",
      "https://workspace.example.test",
    ]);
  });

  it("creates tenant-bound short-lived sessions without exposing credential secrets in stored records", async () => {
    const audit = new MemoryAuditStore();
    const store = new InMemoryDojoHostedRuntimeSessionStore();
    const gateway = gatewayWith({
      audit,
      store,
      ids: ["session-id", "runtime-id", "credential-id"],
      secrets: ["secret-a"],
    });

    const created = await gateway.createSession({
      tenant: tenant("tenant-a", "workspace-a"),
      skill_id: "skill-a",
      run_id: "run-a",
      workspace_url: "https://workspace.example.test/app",
      origin_allowlist: ["https://workspace.example.test/any-path"],
      ttl_ms: 900_000,
      credential_ttl_ms: 60_000,
      sensitive_workspace: true,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected_session_create_success");
    expect(created.session).toEqual(expect.objectContaining({
      session_id: "dojo_runtime_session_session-id",
      runtime_id: "dojo_runtime_runtime-id",
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      skill_id: "skill-a",
      run_id: "run-a",
      workspace_origin: "https://workspace.example.test",
      origin_allowlist: ["https://workspace.example.test"],
      expires_at: "2026-06-11T00:15:00.000Z",
      credential_id: "runtime_cred_credential-id",
      credential_expires_at: "2026-06-11T00:01:00.000Z",
      egress_policy: { local_network_allowed: false },
      redaction_policy: { screenshots: true },
      audit_event_refs: [created.audit_event_id],
      evidence_refs: [],
    }));
    expect(created.session).not.toHaveProperty("credential_secret");
    expect(created.credentials).toEqual({
      credential_id: "runtime_cred_credential-id",
      credential_secret: "secret-a",
      expires_at: "2026-06-11T00:01:00.000Z",
    });
    expect(created.session.credential_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.events.map((event) => event.event_type)).toEqual(["runtime_session_created"]);
  });

  it("rejects unsafe session configuration before credentials are issued", async () => {
    const audit = new MemoryAuditStore();
    const gateway = gatewayWith({ audit });

    const created = await gateway.createSession({
      tenant: tenant("tenant-a", "workspace-a"),
      skill_id: "skill-a",
      run_id: "run-a",
      workspace_url: "https://workspace.example.test/app",
      origin_allowlist: ["https://other.example.test"],
      ttl_ms: 3_600_001,
      credential_ttl_ms: 10_000,
      sensitive_workspace: true,
      redact_screenshots: false,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(created).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: expect.arrayContaining([
        "runtime_workspace_origin_not_allowed",
        "runtime_session_ttl_too_long",
        "runtime_screenshot_redaction_required",
      ]),
    }));
    expect(audit.events).toEqual([
      expect.objectContaining({
        event_type: "runtime_session_rejected",
        details: expect.objectContaining({
          blocked_by: expect.arrayContaining(["runtime_workspace_origin_not_allowed"]),
        }),
      }),
    ]);
  });

  it("rejects sessions that are not bound to a skill and run", async () => {
    const audit = new MemoryAuditStore();
    const gateway = gatewayWith({ audit });

    const created = await gateway.createSession({
      tenant: tenant("tenant-a", "workspace-a"),
      skill_id: " ",
      run_id: "",
      workspace_url: "https://workspace.example.test/app",
      origin_allowlist: ["https://workspace.example.test"],
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(created).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: [
        "runtime_skill_binding_required",
        "runtime_run_binding_required",
      ],
    }));
    expect(audit.events).toEqual([
      expect.objectContaining({
        event_type: "runtime_session_rejected",
        details: expect.objectContaining({
          blocked_by: [
            "runtime_skill_binding_required",
            "runtime_run_binding_required",
          ],
        }),
      }),
    ]);
  });

  it("rejects local-network hosted sessions unless egress is explicitly allowed", async () => {
    const audit = new MemoryAuditStore();
    const gateway = gatewayWith({ audit });

    for (const workspaceUrl of [
      "http://127.0.0.1:3000/app",
      "http://169.254.10.20/app",
      "http://100.64.1.5/app",
      "http://[fd00::1]/app",
      "http://[fe80::1]/app",
      "http://[::ffff:192.168.1.10]/app",
      "http://device.local/app",
    ]) {
      const blocked = await gateway.createSession({
        tenant: tenant("tenant-a", "workspace-a"),
        skill_id: "skill-a",
        run_id: "run-a",
        workspace_url: workspaceUrl,
        origin_allowlist: [workspaceUrl],
        now: "2026-06-11T00:00:00.000Z",
      });

      expect(blocked).toEqual(expect.objectContaining({
        ok: false,
        blocked_by: ["runtime_local_network_blocked"],
      }));
    }
    const allowed = await gateway.createSession({
      tenant: tenant("tenant-a", "workspace-a"),
      skill_id: "skill-a",
      run_id: "run-a",
      workspace_url: "http://127.0.0.1:3000/app",
      origin_allowlist: ["http://127.0.0.1:3000"],
      local_network_allowed: true,
      now: "2026-06-11T00:00:00.000Z",
    });

    expect(allowed).toEqual(expect.objectContaining({ ok: true }));
    if (!allowed.ok) throw new Error("expected_local_network_opt_in_success");
    expect(allowed.session.egress_policy).toEqual({ local_network_allowed: true });
  });

  it("authorizes runtime actions only with matching tenant, skill, run, origin, credential, and evidence write", async () => {
    const audit = new MemoryAuditStore();
    const evidence = new MemoryRuntimeEvidenceWriter();
    const gateway = gatewayWith({
      audit,
      evidence,
      ids: ["session-id", "runtime-id", "credential-id"],
      secrets: ["secret-a"],
    });
    const created = await createSession(gateway);
    if (!created.ok) throw new Error("expected_session_create_success");

    const authorized = await gateway.authorizeAction({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: created.session.session_id,
      skill_id: "skill-a",
      run_id: "run-a",
      action_kind: "graph_action",
      url: "https://workspace.example.test/app/invoices",
      credential_id: created.credentials.credential_id,
      credential_secret: created.credentials.credential_secret,
      now: "2026-06-11T00:00:30.000Z",
      details: { graph_node_id: "node-submit" },
    });

    expect(authorized).toEqual(expect.objectContaining({
      ok: true,
      status: "authorized",
      blocked_by: [],
      evidence_record_ids: ["runtime-evidence-001"],
    }));
    expect(evidence.records).toEqual([
      expect.objectContaining({
        action_kind: "graph_action",
        url_origin: "https://workspace.example.test",
      }),
    ]);
    expect(audit.events.map((event) => event.event_type)).toEqual([
      "runtime_session_created",
      "runtime_action_authorized",
    ]);
  });

  it("blocks action attempts with wrong credentials, origin drift, local network egress, or run mismatch", async () => {
    const audit = new MemoryAuditStore();
    const evidence = new MemoryRuntimeEvidenceWriter();
    const gateway = gatewayWith({
      audit,
      evidence,
      ids: ["session-id", "runtime-id", "credential-id"],
      secrets: ["secret-a"],
    });
    const created = await createSession(gateway);
    if (!created.ok) throw new Error("expected_session_create_success");

    const wrongCredential = await gateway.authorizeAction({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: created.session.session_id,
      skill_id: "skill-a",
      run_id: "run-a",
      action_kind: "control",
      url: "https://workspace.example.test/app",
      credential_id: created.credentials.credential_id,
      credential_secret: "wrong-secret",
      now: "2026-06-11T00:00:30.000Z",
    });
    expect(wrongCredential.blocked_by).toEqual(["runtime_credential_invalid"]);

    const wrongOrigin = await gateway.authorizeAction({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: created.session.session_id,
      skill_id: "skill-a",
      run_id: "run-a",
      action_kind: "control",
      url: "https://other.example.test/app",
      credential_id: created.credentials.credential_id,
      credential_secret: created.credentials.credential_secret,
      now: "2026-06-11T00:00:30.000Z",
    });
    expect(wrongOrigin.blocked_by).toEqual(["runtime_origin_not_allowed"]);

    const localNetwork = await gateway.authorizeAction({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: created.session.session_id,
      skill_id: "skill-a",
      run_id: "run-a",
      action_kind: "control",
      url: "http://127.0.0.1:3000/app",
      credential_id: created.credentials.credential_id,
      credential_secret: created.credentials.credential_secret,
      now: "2026-06-11T00:00:30.000Z",
    });
    expect(localNetwork.blocked_by).toEqual(expect.arrayContaining([
      "runtime_origin_not_allowed",
      "runtime_local_network_blocked",
    ]));

    const wrongRun = await gateway.authorizeAction({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: created.session.session_id,
      skill_id: "skill-a",
      run_id: "run-b",
      action_kind: "control",
      url: "https://workspace.example.test/app",
      credential_id: created.credentials.credential_id,
      credential_secret: created.credentials.credential_secret,
      now: "2026-06-11T00:00:30.000Z",
    });
    expect(wrongRun.blocked_by).toEqual(["runtime_run_mismatch"]);
    expect(evidence.records).toEqual([]);
    expect(audit.events.filter((event) => event.event_type === "runtime_action_blocked")).toHaveLength(4);
  });

  it("fails closed when evidence cannot be written for an otherwise valid action", async () => {
    const audit = new MemoryAuditStore();
    const gateway = gatewayWith({
      audit,
      ids: ["session-id", "runtime-id", "credential-id"],
      secrets: ["secret-a"],
    });
    const created = await createSession(gateway);
    if (!created.ok) throw new Error("expected_session_create_success");

    const decision = await gateway.authorizeAction({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: created.session.session_id,
      skill_id: "skill-a",
      run_id: "run-a",
      action_kind: "graph_action",
      url: "https://workspace.example.test/app/invoices",
      credential_id: created.credentials.credential_id,
      credential_secret: created.credentials.credential_secret,
      now: "2026-06-11T00:00:30.000Z",
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: false,
      blocked_by: ["runtime_evidence_writer_missing"],
      evidence_record_ids: [],
    }));
  });

  it("expires and revokes sessions before authorizing further actions", async () => {
    const audit = new MemoryAuditStore();
    const evidence = new MemoryRuntimeEvidenceWriter();
    const store = new InMemoryDojoHostedRuntimeSessionStore();
    const gateway = gatewayWith({
      audit,
      evidence,
      store,
      ids: ["session-id", "runtime-id", "credential-id"],
      secrets: ["secret-a"],
    });
    const created = await createSession(gateway);
    if (!created.ok) throw new Error("expected_session_create_success");

    const expired = await gateway.authorizeAction({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: created.session.session_id,
      skill_id: "skill-a",
      run_id: "run-a",
      action_kind: "snapshot",
      url: "https://workspace.example.test/app",
      credential_id: created.credentials.credential_id,
      credential_secret: created.credentials.credential_secret,
      now: "2026-06-11T00:16:00.000Z",
    });
    expect(expired.blocked_by).toContain("runtime_session_expired");
    expect(store.getSession({
      tenant_id: "tenant-a",
      workspace_id: "workspace-a",
      session_id: created.session.session_id,
    })?.status).toBe("expired");

    const secondGateway = gatewayWith({
      audit: new MemoryAuditStore(),
      evidence: new MemoryRuntimeEvidenceWriter(),
      ids: ["session-two", "runtime-two", "credential-two"],
      secrets: ["secret-two"],
    });
    const second = await createSession(secondGateway);
    if (!second.ok) throw new Error("expected_second_session_create_success");
    const revoked = await secondGateway.revokeSession({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: second.session.session_id,
      reason: "operator_revoked",
      now: "2026-06-11T00:00:30.000Z",
    });
    expect(revoked.ok).toBe(true);
    const afterRevoke = await secondGateway.authorizeAction({
      tenant: tenant("tenant-a", "workspace-a"),
      session_id: second.session.session_id,
      skill_id: "skill-a",
      run_id: "run-a",
      action_kind: "snapshot",
      url: "https://workspace.example.test/app",
      credential_id: second.credentials.credential_id,
      credential_secret: second.credentials.credential_secret,
      now: "2026-06-11T00:00:31.000Z",
    });
    expect(afterRevoke.blocked_by).toEqual(["runtime_session_revoked"]);
  });
});

function gatewayWith(options: {
  audit: MemoryAuditStore;
  store?: InMemoryDojoHostedRuntimeSessionStore;
  evidence?: DojoHostedRuntimeEvidenceWriter;
  ids?: string[];
  secrets?: string[];
}) {
  const ids = [...(options.ids ?? [])];
  const secrets = [...(options.secrets ?? [])];
  return createInProcessDojoHostedRuntimeGateway({
    audit_store: options.audit,
    store: options.store,
    evidence_writer: options.evidence,
    random_id: () => ids.shift() ?? "id",
    random_secret: () => secrets.shift() ?? "secret",
  });
}

function createSession(gateway: ReturnType<typeof createInProcessDojoHostedRuntimeGateway>) {
  return gateway.createSession({
    tenant: tenant("tenant-a", "workspace-a"),
    skill_id: "skill-a",
    run_id: "run-a",
    workspace_url: "https://workspace.example.test/app",
    origin_allowlist: ["https://workspace.example.test"],
    ttl_ms: 900_000,
    credential_ttl_ms: 60_000,
    now: "2026-06-11T00:00:00.000Z",
  });
}

function tenant(tenantId: string, workspaceId: string): DojoTenantContext {
  return {
    tenant_id: tenantId,
    organization_id: "org-a",
    workspace_id: workspaceId,
    actor_id: "agent-a",
    actor_type: "agent",
    roles: ["dojo:runtime"],
    request_id: `req-${tenantId}-${workspaceId}`,
    correlation_id: `corr-${tenantId}-${workspaceId}`,
  };
}

class MemoryAuditStore implements DojoAuditStore {
  readonly events: DojoAuditEventRecord[] = [];

  appendAuditEvent(event: DojoAuditEventInput): DojoAuditEventRecord {
    const record: DojoAuditEventRecord = {
      tenant_id: event.tenant_id,
      workspace_id: event.workspace_id,
      audit_event_id: event.audit_event_id ?? `audit-${this.events.length + 1}`,
      actor: event.actor,
      event_type: event.event_type,
      request_id: event.request_id,
      correlation_id: event.correlation_id,
      ...(event.entity_kind ? { entity_kind: event.entity_kind } : {}),
      ...(event.entity_id ? { entity_id: event.entity_id } : {}),
      details: event.details ?? {},
      created_at: event.created_at ?? "2026-06-11T00:00:00.000Z",
    };
    this.events.push(record);
    return record;
  }

  listAuditEvents(filter: DojoAuditEventListFilter = {}): DojoAuditEventRecord[] {
    return this.events
      .filter((event) => !filter.event_type || event.event_type === filter.event_type)
      .filter((event) => !filter.entity_kind || event.entity_kind === filter.entity_kind)
      .filter((event) => !filter.entity_id || event.entity_id === filter.entity_id)
      .filter((event) => !filter.correlation_id || event.correlation_id === filter.correlation_id)
      .slice(0, filter.limit ?? this.events.length);
  }
}

class MemoryRuntimeEvidenceWriter implements DojoHostedRuntimeEvidenceWriter {
  readonly records: Array<{
    action_kind: string;
    url_origin: string;
    session_id: string;
  }> = [];

  appendRuntimeActionEvidence(input: Parameters<DojoHostedRuntimeEvidenceWriter["appendRuntimeActionEvidence"]>[0]) {
    const recordId = `runtime-evidence-${String(this.records.length + 1).padStart(3, "0")}`;
    this.records.push({
      action_kind: input.action_kind,
      url_origin: input.url_origin,
      session_id: input.session.session_id,
    });
    return { record_id: recordId };
  }
}
