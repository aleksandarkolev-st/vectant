import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DojoPermissionLicense } from "../../src/browser/dojo.js";
import {
  applyDojoSourceDriftExpiry,
  buildDojoSourceDriftRecertificationHandoff,
  detectDojoSourceDrift,
  type DojoSourceDriftReport,
} from "../../src/dojo/source/source_drift.js";
import { buildDojoSourceSnapshot } from "../../src/dojo/source/source_snapshot.js";
import type {
  DojoAuditActor,
  DojoLicenseStore,
  DojoPermissionLicenseRecord,
} from "../../src/dojo/store/interfaces.js";

describe("Dojo source drift expiry", () => {
  it("expires graph nodes mapped to changed source tokens", () => {
    const previous = snapshotFixture("2026.06.11", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
      { token_id: "total-field", route: "/invoices", component: "InvoiceForm", source_locator: "src/InvoiceForm.jsx:24", risk: "safe" },
    ]);
    const next = snapshotFixture("2026.06.12", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:99", risk: "mutation" },
      { token_id: "total-field", route: "/invoices", component: "InvoiceForm", source_locator: "src/InvoiceForm.jsx:24", risk: "safe" },
    ]);

    const report = detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [
        { node_id: "action_submit", source_token_ids: ["save-button"], license_id: "license-a" },
      ],
      source_snapshot_signing_keys_by_id: sourceSigningKeys(),
    });

    expect(report).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.sourceDriftReport.v1",
      drifted_token_ids: ["save-button"],
      affected_nodes: [
        expect.objectContaining({
          node_id: "action_submit",
          source_token_id: "save-button",
          drift_kind: "changed",
          license_id: "license-a",
        }),
      ],
    }));
    expect(report.license_expiry_triggers).toEqual([
      expect.objectContaining({
        node_id: "action_submit",
        source_token_id: "save-button",
        license_id: "license-a",
      }),
    ]);
  });

  it("does not expire a skill when only unrelated source tokens change", () => {
    const previous = snapshotFixture("2026.06.11", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
      { token_id: "other-button", route: "/settings", component: "Settings", action: "saveSettings", source_locator: "src/Settings.jsx:10", risk: "mutation" },
    ]);
    const next = snapshotFixture("2026.06.12", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
      { token_id: "other-button", route: "/settings", component: "Settings", action: "saveSettings", source_locator: "src/Settings.jsx:99", risk: "mutation" },
    ]);

    const report = detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [
        { node_id: "action_submit", source_token_ids: ["save-button"], license_id: "license-a" },
      ],
      source_snapshot_signing_keys_by_id: sourceSigningKeys(),
    });

    expect(report.drifted_token_ids).toEqual(["other-button"]);
    expect(report.affected_nodes).toEqual([]);
    expect(report.license_expiry_triggers).toEqual([]);
  });

  it("marks removed source tokens as drift", () => {
    const previous = snapshotFixture("2026.06.11", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
    ]);
    const next = snapshotFixture("2026.06.12", []);

    const report = detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [{ node_id: "action_submit", source_token_ids: ["save-button"] }],
      source_snapshot_signing_keys_by_id: sourceSigningKeys(),
    });

    expect(report.affected_nodes).toEqual([
      expect.objectContaining({ drift_kind: "removed", source_token_id: "save-button" }),
    ]);
  });

  it("expires bound nodes when source content changes behind a stable token", () => {
    const previous = snapshotFixture("2026.06.11", [
      {
        token_id: "save-button",
        route: "/invoices",
        component: "InvoiceForm",
        action: "saveInvoice",
        source_locator: "src/InvoiceForm.jsx:42",
        source_sha256: hashSource("saveInvoice:v1"),
        risk: "mutation",
      },
    ]);
    const next = snapshotFixture("2026.06.12", [
      {
        token_id: "save-button",
        route: "/invoices",
        component: "InvoiceForm",
        action: "saveInvoice",
        source_locator: "src/InvoiceForm.jsx:42",
        source_sha256: hashSource("saveInvoice:v2"),
        risk: "mutation",
      },
    ]);

    const report = detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [{ node_id: "action_submit", source_token_ids: ["save-button"], license_id: "license-a" }],
      source_snapshot_signing_keys_by_id: sourceSigningKeys(),
    });

    expect(report.drifted_token_ids).toEqual(["save-button"]);
    expect(report.affected_nodes).toEqual([
      expect.objectContaining({
        node_id: "action_submit",
        source_token_id: "save-button",
        drift_kind: "changed",
      }),
    ]);
    expect(report.license_expiry_triggers).toHaveLength(1);
  });

  it("reports newly added risky affordances for review", () => {
    const previous = snapshotFixture("2026.06.11", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
    ]);
    const next = snapshotFixture("2026.06.12", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
      { token_id: "delete-button", route: "/invoices", component: "InvoiceForm", action: "deleteInvoice", source_locator: "src/InvoiceForm.jsx:88", risk: "dangerous" },
      { token_id: "title", route: "/invoices", component: "InvoiceHeader", source_locator: "src/InvoiceHeader.jsx:12", risk: "safe" },
    ]);

    const report = detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [{ node_id: "action_delete", source_token_ids: ["delete-button"], license_id: "license-a" }],
      source_snapshot_signing_keys_by_id: sourceSigningKeys(),
    });

    expect(report.added_token_ids).toEqual(["delete-button", "title"]);
    expect(report.review_required_token_ids).toEqual(["delete-button"]);
    expect(report.affected_nodes).toEqual([
      expect.objectContaining({
        node_id: "action_delete",
        source_token_id: "delete-button",
        drift_kind: "added",
      }),
    ]);
  });

  it("rejects drift reports from tampered or unverifiable source snapshots", () => {
    const previous = snapshotFixture("2026.06.11", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:42", risk: "mutation" },
    ]);
    const next = snapshotFixture("2026.06.12", [
      { token_id: "save-button", route: "/invoices", component: "InvoiceForm", action: "saveInvoice", source_locator: "src/InvoiceForm.jsx:99", risk: "mutation" },
    ]);
    const tamperedNext = {
      ...next,
      source_tokens: next.source_tokens.map((token) => ({ ...token, source_locator: "src/InvoiceForm.jsx:100" })),
    };

    expect(() => detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: tamperedNext,
      node_bindings: [{ node_id: "action_submit", source_token_ids: ["save-button"] }],
      source_snapshot_signing_keys_by_id: sourceSigningKeys(),
    })).toThrow(/dojo_source_drift_next_snapshot_unverified/);
    expect(() => detectDojoSourceDrift({
      previous_snapshot: previous,
      next_snapshot: next,
      node_bindings: [{ node_id: "action_submit", source_token_ids: ["save-button"] }],
      source_snapshot_signing_keys_by_id: {},
    })).toThrow(/dojo_source_drift_previous_snapshot_unverified/);
  });

  it("applies source drift expiry triggers through the license store", async () => {
    const report = reportFixture([
      triggerFixture({ trigger_id: "trigger-a", license_id: "license-a", node_id: "action_submit", source_token_id: "save-button" }),
      triggerFixture({ trigger_id: "trigger-b", license_id: "license-a", node_id: "action_assert", source_token_id: "save-button" }),
      triggerFixture({ trigger_id: "trigger-no-license", node_id: "action_observe", source_token_id: "title" }),
    ]);
    const store = new FakeLicenseStore([
      licenseRecordFixture({ license_id: "license-a", status: "active" }),
    ]);

    const result = await applyDojoSourceDriftExpiry({
      report,
      license_store: store,
      expired_by: actorFixture(),
      now: "2026-06-12T00:00:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      trigger_count: 3,
      unique_license_count: 1,
      expired_license_count: 1,
      skipped_trigger_count: 1,
      failed_expiration_count: 0,
      blocked_by: [],
    }));
    expect(result.expired_licenses).toEqual([
      expect.objectContaining({
        license_id: "license-a",
        trigger_ids: ["trigger-a", "trigger-b"],
        node_ids: ["action_assert", "action_submit"],
        source_token_ids: ["save-button"],
        record: expect.objectContaining({
          status: "expired",
          expires_at: "2026-06-12T00:00:00.000Z",
        }),
      }),
    ]);
    expect(result.skipped_triggers).toEqual([
      expect.objectContaining({
        trigger_id: "trigger-no-license",
        reason: "license_id_missing",
      }),
    ]);
    expect(store.expireCalls).toEqual([
      expect.objectContaining({
        license_id: "license-a",
        now: "2026-06-12T00:00:00.000Z",
        expired_by: actorFixture(),
      }),
    ]);
    expect(store.records.get("license-a")).toEqual(expect.objectContaining({
      status: "expired",
      revoked_reason: expect.stringContaining("source_drift:snapshot-previous->snapshot-next"),
    }));
  });

  it("fails closed when source drift names a missing license record", async () => {
    const report = reportFixture([
      triggerFixture({ trigger_id: "trigger-missing", license_id: "license-missing" }),
    ]);
    const result = await applyDojoSourceDriftExpiry({
      report,
      license_store: new FakeLicenseStore([]),
      expired_by: actorFixture(),
      now: "2026-06-12T00:00:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      expired_license_count: 0,
      failed_expiration_count: 1,
      blocked_by: ["source_drift_license_record_missing"],
    }));
    expect(result.failed_expirations).toEqual([
      expect.objectContaining({
        license_id: "license-missing",
        trigger_ids: ["trigger-missing"],
        reason: "license_record_missing",
      }),
    ]);
  });

  it("skips source drift expiry for already terminal licenses", async () => {
    const report = reportFixture([
      triggerFixture({ trigger_id: "trigger-expired", license_id: "license-expired" }),
      triggerFixture({ trigger_id: "trigger-revoked", license_id: "license-revoked" }),
    ]);
    const store = new FakeLicenseStore([
      licenseRecordFixture({ license_id: "license-expired", status: "expired" }),
      licenseRecordFixture({ license_id: "license-revoked", status: "revoked" }),
    ]);

    const result = await applyDojoSourceDriftExpiry({
      report,
      license_store: store,
      expired_by: actorFixture(),
      now: "2026-06-12T00:00:00.000Z",
    });

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      expired_license_count: 0,
      skipped_trigger_count: 2,
      failed_expiration_count: 0,
    }));
    expect(result.skipped_triggers).toEqual([
      expect.objectContaining({ trigger_id: "trigger-expired", reason: "license_already_expired", status: "expired" }),
      expect.objectContaining({ trigger_id: "trigger-revoked", reason: "license_not_active", status: "revoked" }),
    ]);
    expect(store.expireCalls).toEqual([]);
  });

  it("builds source drift recertification handoff before relicense", async () => {
    const report = reportFixture([
      triggerFixture({ trigger_id: "trigger-submit", license_id: "license-a" }),
    ]);
    const application = await applyDojoSourceDriftExpiry({
      report,
      license_store: new FakeLicenseStore([licenseRecordFixture({
        license_id: "license-a",
        skill_id: "skill-a",
      })]),
      expired_by: actorFixture(),
      now: "2026-06-12T00:00:00.000Z",
    });

    const dryRunHandoff = buildDojoSourceDriftRecertificationHandoff({
      report,
      application,
      dry_run: true,
      skills_by_id: {
        "skill-a": { skill_id: "skill-a", workflow_id: "workflow-a" },
      },
    });

    expect(dryRunHandoff).toEqual(expect.objectContaining({
      schema_version: "synthi.dojo.sourceDriftRecertificationHandoff.v1",
      dry_run: true,
      required_tool: "synthi_dojo_recertify_skill",
      relicense_allowed_without_recertification: false,
      queue_count: 1,
      would_queue_count: 1,
      queued_count: 0,
      skipped_count: 0,
      required_before_relicense: expect.arrayContaining([
        "run_synthi_dojo_recertify_skill",
        "provide_current_workflow_artifact",
        "provide_explicit_evidence_refs",
        "pass_executable_checkride",
      ]),
      evidence_policy: expect.objectContaining({
        evidence_refs_required: true,
        ledger_backed_when_enforced: true,
      }),
      blocked_by: [],
      ok: true,
    }));
    expect(dryRunHandoff.queue[0]).toEqual(expect.objectContaining({
      status: "would_queue",
      skill_id: "skill-a",
      workflow_id: "workflow-a",
      license_id: "license-a",
      required_tool: "synthi_dojo_recertify_skill",
      suggested_args: expect.objectContaining({
        skill_id: "skill-a",
        workflow_id: "workflow-a",
        evidence_refs: [],
        actor_id: null,
        actor_type: null,
      }),
      skipped_by: [],
    }));
    expect(dryRunHandoff.queue[0].source_drift_reason).toContain("source_drift:snapshot-previous->snapshot-next");

    const queuedHandoff = buildDojoSourceDriftRecertificationHandoff({
      report,
      application,
      dry_run: false,
      skill_updates: [{
        skill_id: "skill-a",
        workflow_id: "workflow-a",
        license_id: "license-a",
        status: "expired",
        recertification_trigger_id: "retrain-custom",
      }],
      skills_by_id: {
        "skill-a": { skill_id: "skill-a", workflow_id: "workflow-a" },
      },
    });
    expect(queuedHandoff.queue[0]).toEqual(expect.objectContaining({
      status: "queued",
      recertification_trigger: expect.objectContaining({ trigger_id: "retrain-custom" }),
    }));

    const skippedHandoff = buildDojoSourceDriftRecertificationHandoff({
      report,
      application,
      dry_run: false,
      skill_updates: [{
        skill_id: "skill-a",
        license_id: "license-a",
        status: "skipped",
        skipped_by: ["source_drift_skill_record_missing"],
      }],
      skills_by_id: {},
    });
    expect(skippedHandoff).toEqual(expect.objectContaining({
      ok: false,
      skipped_count: 1,
      blocked_by: ["source_drift_skill_record_missing"],
    }));
    expect(skippedHandoff.queue[0].status).toBe("skipped");
  });
});

function snapshotFixture(appVersion: string, sourceTokens: Parameters<typeof buildDojoSourceSnapshot>[0]["source_tokens"]) {
  return buildDojoSourceSnapshot({
    tenant_id: "tenant-a",
    workspace_id: "workspace-a",
    app_origin: "https://app.example.test",
    app_version: appVersion,
    commit_sha: `commit-${appVersion}`,
    source_root: "src",
    source_tokens: sourceTokens,
    signer_key_id: "source-key-a",
    signing_key: sourceSigningKey(),
    created_at: "2026-06-11T00:00:00.000Z",
  });
}

function sourceSigningKeys(): Record<string, string> {
  return { "source-key-a": sourceSigningKey() };
}

function sourceSigningKey(): string {
  return "source-signing-secret-a";
}

function hashSource(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reportFixture(licenseExpiryTriggers: DojoSourceDriftReport["license_expiry_triggers"]): DojoSourceDriftReport {
  return {
    schema_version: "synthi.dojo.sourceDriftReport.v1",
    previous_snapshot_id: "snapshot-previous",
    next_snapshot_id: "snapshot-next",
    app_origin: "https://app.example.test",
    previous_app_version: "2026.06.11",
    next_app_version: "2026.06.12",
    drifted_token_ids: [...new Set(licenseExpiryTriggers.map((trigger) => trigger.source_token_id))].sort(),
    added_token_ids: [],
    review_required_token_ids: [],
    affected_nodes: licenseExpiryTriggers.map((trigger) => ({
      node_id: trigger.node_id,
      source_token_id: trigger.source_token_id,
      drift_kind: "changed",
      ...(trigger.license_id ? { license_id: trigger.license_id } : {}),
    })),
    license_expiry_triggers: licenseExpiryTriggers,
  };
}

function triggerFixture(overrides: Partial<DojoSourceDriftReport["license_expiry_triggers"][number]> = {}): DojoSourceDriftReport["license_expiry_triggers"][number] {
  const nodeId = overrides.node_id ?? "action_submit";
  const sourceTokenId = overrides.source_token_id ?? "save-button";
  return {
    trigger_id: overrides.trigger_id ?? `source_drift_${nodeId}_${sourceTokenId}`,
    node_id: nodeId,
    source_token_id: sourceTokenId,
    reason: overrides.reason ?? `Source token ${sourceTokenId} changed.`,
    ...(overrides.license_id ? { license_id: overrides.license_id } : {}),
  };
}

function actorFixture(): DojoAuditActor {
  return { actor_id: "source-drift-reviewer", actor_type: "service" };
}

class FakeLicenseStore implements Pick<DojoLicenseStore, "getLicense" | "expireLicense"> {
  readonly records: Map<string, DojoPermissionLicenseRecord>;
  readonly expireCalls: Array<{
    license_id: string;
    reason: string;
    now: string | undefined;
    expired_by: DojoAuditActor | undefined;
    expires_at: string | undefined;
  }> = [];

  constructor(records: DojoPermissionLicenseRecord[]) {
    this.records = new Map(records.map((record) => [record.license_id, { ...record }]));
  }

  getLicense(licenseId: string): DojoPermissionLicenseRecord | null {
    const record = this.records.get(licenseId);
    return record ? { ...record, license_json: { ...record.license_json } } : null;
  }

  expireLicense(
    licenseId: string,
    reason: string,
    now?: string,
    expiredBy?: DojoAuditActor,
    options: { expires_at?: string } = {}
  ): DojoPermissionLicenseRecord | null {
    this.expireCalls.push({
      license_id: licenseId,
      reason,
      now,
      expired_by: expiredBy,
      expires_at: options.expires_at,
    });
    const record = this.records.get(licenseId);
    if (!record) return null;
    const expired = {
      ...record,
      status: "expired" as const,
      expires_at: options.expires_at ?? now ?? record.expires_at,
      revoked_reason: reason,
      updated_at: now ?? record.updated_at,
    };
    this.records.set(licenseId, expired);
    return { ...expired, license_json: { ...expired.license_json } };
  }
}

function licenseRecordFixture(overrides: Partial<DojoPermissionLicenseRecord> = {}): DojoPermissionLicenseRecord {
  const licenseId = overrides.license_id ?? "license-a";
  const skillId = overrides.skill_id ?? "skill-a";
  const licenseVersion = overrides.license_version ?? "1.0.0";
  const issuedAt = overrides.created_at ?? "2026-06-11T00:00:00.000Z";
  const licenseJson: DojoPermissionLicense = {
    schema_version: "synthi.dojo.permissionLicense.v1",
    license_id: licenseId,
    skill_id: skillId,
    license_version: licenseVersion,
    entrustment_level: overrides.entrustment_level ?? "E3",
    autonomy_level: "submit_gated",
    allowed_actions: [{ action: "submit_invoice", constraints: [] }],
    gated_actions: [],
    blocked_actions: [],
    evidence_requirements: [],
    approval_requirements: [],
    substrate_requirements: [],
    proof_requirements: {
      required_context_claims: [],
      required_evidence_claims: [],
      required_guardrails: [],
    },
    expiry_policy: {
      expires_on: ["source_drift"],
      recertify_after_days: 30,
    },
    issued_at: issuedAt,
  };
  return {
    tenant_id: overrides.tenant_id ?? "tenant-a",
    workspace_id: overrides.workspace_id ?? "workspace-a",
    license_id: licenseId,
    skill_id: skillId,
    license_version: licenseVersion,
    status: overrides.status ?? "active",
    entrustment_level: licenseJson.entrustment_level,
    readiness_level: overrides.readiness_level ?? 7,
    license_json: overrides.license_json ?? licenseJson,
    expires_at: overrides.expires_at ?? "2026-07-11T00:00:00.000Z",
    created_at: issuedAt,
    updated_at: overrides.updated_at ?? issuedAt,
    ...(overrides.revoked_at ? { revoked_at: overrides.revoked_at } : {}),
    ...(overrides.revoked_reason ? { revoked_reason: overrides.revoked_reason } : {}),
  };
}
