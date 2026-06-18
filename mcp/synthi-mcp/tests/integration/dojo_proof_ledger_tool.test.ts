import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { browserBroker } from "../../src/browser/broker.js";
import { createServer, type Server } from "node:http";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { buildDojoSkill, dojoSkillRegistry } from "../../src/browser/dojo.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { PostgresDojoEvidenceLedgerStore } from "../../src/dojo/evidence/ledger_store.js";
import { applyDojoPostgresMigrations } from "../../src/dojo/store/postgres_proof_store.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

const postgresUrl = process.env["SYNTHI_DOJO_POSTGRES_TEST_URL"];
const describeWithPostgres = postgresUrl ? describe : describe.skip;
const originalEnv = { ...process.env };

describeWithPostgres("Dojo proof issuance from Postgres evidence ledger", () => {
  let pool: Pool;
  let tenantId: string;
  let workspaceId: string;
  let organizationId: string;

  beforeAll(async () => {
    if (!postgresUrl) throw new Error("SYNTHI_DOJO_POSTGRES_TEST_URL required");
    pool = new Pool({ connectionString: postgresUrl });
    await applyDojoPostgresMigrations(pool);
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    tenantId = uniqueId("tenant_tool_ledger");
    workspaceId = "workspace-a";
    organizationId = "org-a";
    browserBroker.resetForTests();
    sourceIdentityRegistry.resetForTests();
    privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
    privateWorkflowToolRegistry.resetForTests();
    dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
    dojoSkillRegistry.resetForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it("issues a production proof capsule from evidence record IDs resolved through Postgres", async () => {
    const apiServer = await startApiToolHttpServer({
      status: 201,
      body: { invoice: { status: "saved" } },
    });
    process.env.SYNTHI_DOJO_PRODUCTION_ENFORCEMENT = "1";
    process.env.SYNTHI_DOJO_REQUIRE_DURABLE_STORE = "1";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_STORE = "postgres";
    process.env.SYNTHI_DOJO_CONTROL_PLANE_POSTGRES_URL = postgresUrl;
    process.env.SYNTHI_DOJO_REQUIRE_EVIDENCE_LEDGER = "1";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_STORE = "postgres";
    process.env.SYNTHI_DOJO_EVIDENCE_LEDGER_POSTGRES_URL = postgresUrl;

    try {
      recordOpenDetailsWorkflow(`${apiServer.origin}/settings`);
    const workflowArtifact = browserBroker.workflowArtifact();
    expect(workflowArtifact.ok).toBe(true);
    if (!workflowArtifact.ok) throw new Error(workflowArtifact.error);
    const candidateSkill = buildDojoSkill(workflowArtifact.artifact.workflow.contract, {
      workspace_id: workspaceId,
      now: "2026-06-11T00:00:00.000Z",
    });
    await seedSkillRow(pool, {
      tenant_id: tenantId,
      organization_id: organizationId,
      workspace_id: workspaceId,
      skill_id: candidateSkill.skill_id,
      workflow_id: candidateSkill.workflow_id,
      skill_name: candidateSkill.name,
      skill_json: candidateSkill,
      app_origin: candidateSkill.app_origin,
    });
    const publicationLedgerStore = new PostgresDojoEvidenceLedgerStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const publicationPayload = JSON.stringify({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: candidateSkill.skill_id,
      source_ref: "publication:proof-ledger-tool-test",
      created_at: "2026-06-11T00:00:30.000Z",
    });
    const publicationArtifactSha = sha256(publicationPayload);
    const publicationEvidence = await publicationLedgerStore.append({
      record_id: `publication_${sha256(`${tenantId}:${workspaceId}:${candidateSkill.skill_id}:publication`).slice(0, 24)}`,
      skill_id: candidateSkill.skill_id,
      run_id: `publication_${candidateSkill.skill_id}`,
      kind: "audit",
      artifact_uri: `sha256://${publicationArtifactSha}`,
      artifact_sha256: publicationArtifactSha,
      redaction_manifest_sha256: sha256(JSON.stringify({
        artifact_sha256: publicationArtifactSha,
        redaction_policy: "metadata_only",
      })),
      claim_ids: ["skill_publication_reviewed", "publication_evidence_refs_recorded"],
      created_at: "2026-06-11T00:00:30.000Z",
      created_by: "integration-publisher",
      retention_class: "standard",
      source_refs: ["publication:proof-ledger-tool-test"],
    });
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: workspaceId,
      reason: "postgres_evidence_ledger_tool_test",
      evidence_refs: [publicationEvidence.record_id],
      ...tenantContext({
        actor_id: "integration-publisher",
        actor_type: "human",
        roles: ["dojo:skill:publish"],
        request_id: "req-postgres-proof-publish",
        correlation_id: "corr-postgres-proof-publish",
      }),
    });
    expect(publish?.isError).toBeUndefined();
    const skillId = (publish?.structuredContent as { skill: { skill_id: string } }).skill.skill_id;
    const skill = dojoSkillRegistry.get(skillId);
    expect(skill).toBeTruthy();

    await seedSkillRow(pool, {
      tenant_id: tenantId,
      organization_id: organizationId,
      workspace_id: workspaceId,
      skill_id: skillId,
      workflow_id: skill!.workflow_id,
      skill_name: skill!.name,
      skill_json: skill!,
      app_origin: skill!.app_origin,
    });

    const requiredClaims = [...new Set([
      ...skill!.permission_license.proof_requirements.required_evidence_claims,
      ...skill!.permission_license.proof_requirements.required_context_claims,
    ])];
    expect(requiredClaims.length).toBeGreaterThan(0);
    const createdAt = "2026-06-11T00:00:00.000Z";
    const checkedAt = "2026-06-11T00:05:00.000Z";
    const artifactPayload = JSON.stringify({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      skill_id: skillId,
      claim_ids: requiredClaims,
      created_at: createdAt,
    });
    const artifactSha = sha256(artifactPayload);
    const redactionSha = sha256(JSON.stringify({
      artifact_sha256: artifactSha,
      redacted_fields: [],
    }));
    const recordId = `evidence_${sha256(`${tenantId}:${workspaceId}:${skillId}:checkride`).slice(0, 24)}`;
    const ledgerStore = new PostgresDojoEvidenceLedgerStore({
      tenant_id: tenantId,
      workspace_id: workspaceId,
      queryable: pool,
    });
    const evidenceRecord = await ledgerStore.append({
      record_id: recordId,
      skill_id: skillId,
      run_id: `checkride_${skillId}`,
      kind: "checkride",
      artifact_uri: `sha256://${artifactSha}`,
      artifact_sha256: artifactSha,
      redaction_manifest_sha256: redactionSha,
      claim_ids: requiredClaims,
      signer_key_id: "integration-ledger-key",
      created_at: createdAt,
      created_by: "dojo-proof-ledger-tool-test",
      retention_class: "standard",
      source_refs: ["trace:open-details"],
    });

    const response = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...tenantContext({
        actor_id: "integration-proof-issuer",
        roles: ["dojo:proof:issue"],
        request_id: "req-postgres-proof-issue",
        correlation_id: "corr-postgres-proof-issue",
      }),
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_record_ids: [evidenceRecord.record_id],
      ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
      substrate_claim: "api",
      now: checkedAt,
      expires_at: "2026-06-11T00:15:00.000Z",
    });

    expect(response?.isError).toBeUndefined();
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      skill_id: skillId,
      requested_action: "run_workflow",
      enforcement_mode: "production",
      require_verified_evidence: true,
      proof_capsule: expect.objectContaining({
        skill_id: skillId,
        evidence_record_ids: [evidenceRecord.record_id],
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
      }),
      proof_record: expect.objectContaining({
        skill_id: skillId,
        tenant_id: tenantId,
        workspace_id: workspaceId,
        evidence_record_ids: [evidenceRecord.record_id],
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
      }),
      validation: expect.objectContaining({
        ok: true,
        blocked_by: [],
      }),
    }));

    const issuedContent = response?.structuredContent as {
      proof_capsule: {
        capsule_id: string;
        skill_id: string;
        evidence_record_ids: string[];
        ledger_checkpoint_hash: string;
      };
    };
    const successfulValidation = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: skillId,
      ...tenantContext({
        actor_id: "integration-proof-validator",
        roles: ["agent"],
        request_id: "req-postgres-proof-validate-before-forge",
        correlation_id: "corr-postgres-proof-validate-before-forge",
      }),
      requested_action: "run_workflow",
      proof_capsule: issuedContent.proof_capsule,
      tool_args: { workspace_id: workspaceId, url: `${apiServer.origin}/settings` },
      now: "2026-06-11T00:06:00.000Z",
    });
    expect(successfulValidation?.isError).toBeUndefined();
    expect(successfulValidation?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      evidence_ledger_validation: expect.objectContaining({
        evidence_record_ids: [evidenceRecord.record_id],
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
        evidence_claim_results: expect.arrayContaining([
          expect.objectContaining({ ok: true, status: "verified" }),
        ]),
      }),
      evidence_claim_results: expect.arrayContaining([
        expect.objectContaining({ ok: true, status: "verified" }),
      ]),
    }));

    const apiToolPublication = await dispatchDojoTool("synthi_dojo_prepare_api_backed_tool", {
      skill_id: skillId,
      network_trace: {
        method: "POST",
        url: `${apiServer.origin}/api/invoices?workspace=workspace-a`,
        request_body: { client_id: "client-a", amount: 42 },
        response_body: { invoice: { status: "saved" } },
        source_ref: "trace:postgres-proof-ledger-api-tool",
      },
      candidate_overrides: {
        auth_scope: "invoice:write",
        idempotency_key_location: "header",
        rollback_strategy: "compensating_call",
        postcondition: "invoice.status == 'saved'",
        proof_claim_mapping: {
          workspace_verified: "tenant.workspace_id",
          checkride_passed: "dojo.checkride",
        },
        review_status: "approved",
      },
      requested_action: "run_workflow",
      tool_name: "synthi_api_save_invoice",
      auth_scopes: ["invoice:write"],
      publish_to_skill: true,
      reviewer_actor_id: "integration-api-tool-reviewer",
      reviewer_actor_type: "human",
      review_reason: "Reviewed API-backed tool before ledger revalidation coverage.",
      review_evidence_refs: ["api-review:postgres-proof-ledger-tool"],
      reviewed_at: "2026-06-11T00:06:10.000Z",
      now: "2026-06-11T00:06:15.000Z",
      sample_invocation_args: {
        proof_capsule: issuedContent.proof_capsule,
        request: { client_id: "client-a", amount: 42 },
        query: { workspace: workspaceId },
        idempotency_key: "idem-postgres-proof-ledger-api-sample",
      },
      ...tenantContext({
        actor_id: "integration-api-tool-publisher",
        actor_type: "human",
        roles: ["agent", "dojo:api-tool:prepare", "dojo:api-tool:publish"],
        request_id: "req-postgres-proof-api-tool-publish",
        correlation_id: "corr-postgres-proof-api-tool-publish",
      }),
    });
    expect(apiToolPublication?.isError).toBeUndefined();
    expect(apiToolPublication?.structuredContent).toEqual(expect.objectContaining({
      ready_for_promotion: true,
      api_tool_publication: expect.objectContaining({
        ok: true,
        status: "published",
        published_tool_name: "synthi_api_save_invoice",
      }),
    }));

    const apiToolArgs = {
      proof_capsule: issuedContent.proof_capsule,
      request: { client_id: "client-a", amount: 42 },
      query: { workspace: workspaceId },
      idempotency_key: "idem-postgres-proof-ledger-api-run",
    };
    const successfulApiToolDryRun = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
      tool_args: apiToolArgs,
      auth_scopes: ["invoice:write"],
      dry_run: true,
      now: "2026-06-11T00:06:20.000Z",
      ...tenantContext({
        actor_id: "integration-api-tool-runner",
        roles: ["agent"],
        request_id: "req-postgres-proof-api-tool-before-forge",
        correlation_id: "corr-postgres-proof-api-tool-before-forge",
      }),
    });
    expect(successfulApiToolDryRun?.isError).toBeUndefined();
    expect(successfulApiToolDryRun?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: true,
      skill_id: skillId,
      tool_name: "synthi_api_save_invoice",
      evidence_ledger_validation: expect.objectContaining({
        evidence_record_ids: [evidenceRecord.record_id],
        ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
        evidence_claim_results: expect.arrayContaining([
          expect.objectContaining({ ok: true, status: "verified" }),
        ]),
      }),
      evidence_claim_results: expect.arrayContaining([
        expect.objectContaining({ ok: true, status: "verified" }),
      ]),
      proof_consume: null,
      blocked_by: [],
    }));

    const apiExecutionProofResponse = await dispatchDojoTool("synthi_dojo_issue_proof_capsule", {
      skill_id: skillId,
      ...tenantContext({
        actor_id: "integration-api-proof-issuer",
        roles: ["dojo:proof:issue"],
        request_id: "req-postgres-proof-api-issue",
        correlation_id: "corr-postgres-proof-api-issue",
      }),
      requested_action: "run_workflow",
      context_claims: { workspace_verified: true },
      evidence_record_ids: [evidenceRecord.record_id],
      ledger_checkpoint_hash: evidenceRecord.ledger_head_hash,
      substrate_claim: "api",
      now: "2026-06-11T00:06:25.000Z",
      expires_at: "2026-06-11T00:16:00.000Z",
    });
    expect(apiExecutionProofResponse?.isError).toBeUndefined();
    const apiExecutionProof = (apiExecutionProofResponse?.structuredContent as {
      proof_capsule: typeof issuedContent.proof_capsule;
    }).proof_capsule;
    const executedApiToolArgs = {
      ...apiToolArgs,
      proof_capsule: apiExecutionProof,
      idempotency_key: "idem-postgres-proof-ledger-api-execute",
    };
    const executedApiTool = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
      tool_args: executedApiToolArgs,
      auth_scopes: ["invoice:write"],
      dry_run: false,
      run_id: "api-run-postgres-output-evidence",
      now: "2026-06-11T00:06:30.000Z",
      allow_network_transport: true,
      api_base_url: apiServer.origin,
      ...tenantContext({
        actor_id: "integration-api-tool-runner",
        roles: ["agent"],
        request_id: "req-postgres-proof-api-tool-execute",
        correlation_id: "corr-postgres-proof-api-tool-execute",
      }),
    });
    expect(executedApiTool?.isError).toBeUndefined();
    const executedApiContent = executedApiTool?.structuredContent as {
      api_tool_execution: {
        evidence_record_id: string;
      };
      api_tool_execution_evidence_ledger: {
        ok: boolean;
        required: boolean;
        store_kind: string;
        ledger_records: Array<{
          record_id: string;
          run_id: string;
          skill_id: string;
          artifact_sha256: string;
          ledger_head_hash: string;
          claim_ids: string[];
          source_refs: string[];
        }>;
      };
    };
    const outputEvidenceRecordId = executedApiContent.api_tool_execution.evidence_record_id.replace(/^evidence:/, "");
    expect(executedApiTool?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      dry_run: false,
      tool_name: "synthi_api_save_invoice",
      proof_consume: expect.objectContaining({
        ok: true,
        status: "used",
      }),
      api_tool_execution: expect.objectContaining({
        ok: true,
        status: "executed",
        evidence_record_id: `evidence:${outputEvidenceRecordId}`,
      }),
      api_tool_execution_evidence_ledger: expect.objectContaining({
        ok: true,
        required: true,
        store_kind: "postgres",
        ledger_records: [
          expect.objectContaining({
            record_id: outputEvidenceRecordId,
            run_id: "api-run-postgres-output-evidence",
            skill_id: skillId,
            claim_ids: ["api_tool_execution_recorded"],
            source_refs: expect.arrayContaining([
              `proof_capsule:${apiExecutionProof.capsule_id}`,
              "api_tool:synthi_api_save_invoice@1.0.0",
              "transport:network",
            ]),
          }),
        ],
      }),
      blocked_by: [],
    }));
    const outputEvidenceRows = await pool.query<{
      record_id: string;
      skill_id: string;
      run_id: string;
      kind: string;
      artifact_sha256: string;
      claim_ids: string[];
      source_refs: string[];
    }>(
      `SELECT record_id, skill_id, run_id, kind, artifact_sha256, claim_ids, source_refs
      FROM dojo_evidence_records
      WHERE tenant_id = $1 AND workspace_id = $2 AND record_id = $3`,
      [tenantId, workspaceId, outputEvidenceRecordId]
    );
    expect(outputEvidenceRows.rows).toEqual([
      expect.objectContaining({
        record_id: outputEvidenceRecordId,
        skill_id: skillId,
        run_id: "api-run-postgres-output-evidence",
        kind: "artifact",
        artifact_sha256: executedApiContent.api_tool_execution_evidence_ledger.ledger_records[0]?.artifact_sha256,
        claim_ids: ["api_tool_execution_recorded"],
        source_refs: expect.arrayContaining([
          `proof_capsule:${apiExecutionProof.capsule_id}`,
          "api_tool:synthi_api_save_invoice@1.0.0",
          "transport:network",
        ]),
      }),
    ]);
    expect(apiServer.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/api/invoices?workspace=workspace-a",
        body: { client_id: "client-a", amount: 42 },
        headers: expect.objectContaining({
          "idempotency-key": "idem-postgres-proof-ledger-api-execute",
        }),
      }),
    ]);
    await expect(ledgerStore.verifyRecordChain("2026-06-11T00:06:35.000Z")).resolves.toEqual(expect.objectContaining({
      ok: true,
      blocked_by: [],
    }));

    const replayedApiTool = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
      tool_args: executedApiToolArgs,
      auth_scopes: ["invoice:write"],
      dry_run: false,
      run_id: "api-run-postgres-output-replay",
      now: "2026-06-11T00:06:40.000Z",
      mock_response: {
        status: 201,
        body: { invoice: { status: "saved" } },
      },
      ...tenantContext({
        actor_id: "integration-api-tool-runner",
        roles: ["agent"],
        request_id: "req-postgres-proof-api-tool-replay",
        correlation_id: "corr-postgres-proof-api-tool-replay",
      }),
    });
    expect(replayedApiTool?.isError).toBe(true);
    expect(replayedApiTool?.structuredContent).toEqual(expect.objectContaining({
      error: "proof_capsule_replay_detected",
      ok: false,
      proof_consume: null,
      proof_validation: expect.objectContaining({
        blocked_by: expect.arrayContaining(["proof_capsule_replay_detected"]),
      }),
      blocked_by: expect.arrayContaining(["proof_capsule_replay_detected"]),
      error_codes: ["proof_capsule_replay_detected"],
    }));

    const forgedCheckpointId = `forged_${sha256(`${tenantId}:${workspaceId}:${skillId}:checkpoint`).slice(0, 24)}`;
    await pool.query(
      `INSERT INTO dojo_ledger_checkpoints (tenant_id, workspace_id, checkpoint_id, ledger_head_hash, record_count, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::timestamptz)`,
      [
        tenantId,
        workspaceId,
        forgedCheckpointId,
        "f".repeat(64),
        999_999,
        "2026-06-11T00:06:30.000Z",
      ]
    );

    const rejectedValidation = await dispatchDojoTool("synthi_dojo_validate_proof_capsule", {
      skill_id: skillId,
      ...tenantContext({
        actor_id: "integration-proof-validator",
        roles: ["agent"],
        request_id: "req-postgres-proof-validate-after-forge",
        correlation_id: "corr-postgres-proof-validate-after-forge",
      }),
      requested_action: "run_workflow",
      proof_capsule: issuedContent.proof_capsule,
      tool_args: { workspace_id: workspaceId, url: `${apiServer.origin}/settings` },
      now: "2026-06-11T00:07:00.000Z",
    });
    expect(rejectedValidation?.isError).toBe(true);
    expect(rejectedValidation?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_evidence_ledger_resolution_failed",
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule_id: issuedContent.proof_capsule.capsule_id,
      proof_not_consumed: true,
      blocked_by: expect.arrayContaining(["evidence_checkpoint_record_count_mismatch"]),
      error_codes: ["proof_evidence_claim_unverified"],
    }));

    const rejectedRun = await dispatchDojoTool("synthi_dojo_run_with_proof_capsule", {
      skill_id: skillId,
      ...tenantContext({
        actor_id: "integration-proof-runner",
        roles: ["agent"],
        request_id: "req-postgres-proof-run-after-forge",
        correlation_id: "corr-postgres-proof-run-after-forge",
      }),
      requested_action: "run_workflow",
      proof_capsule: issuedContent.proof_capsule,
      run_id: `run_after_forged_checkpoint_${sha256(`${tenantId}:${workspaceId}:${skillId}`).slice(0, 12)}`,
      tool_args: { workspace_id: workspaceId, url: `${apiServer.origin}/settings` },
      now: "2026-06-11T00:07:30.000Z",
    });
    expect(rejectedRun?.isError).toBe(true);
    expect(rejectedRun?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_evidence_ledger_resolution_failed",
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule_id: issuedContent.proof_capsule.capsule_id,
      proof_not_consumed: true,
      blocked_by: expect.arrayContaining(["evidence_checkpoint_record_count_mismatch"]),
      error_codes: ["proof_evidence_claim_unverified"],
    }));

    const rejectedApiToolRun = await dispatchDojoTool("synthi_dojo_run_api_backed_tool", {
      tool_name: "synthi_api_save_invoice",
      tool_version: "1.0.0",
      tool_args: apiToolArgs,
      auth_scopes: ["invoice:write"],
      dry_run: false,
      run_id: `api_run_after_forged_checkpoint_${sha256(`${tenantId}:${workspaceId}:${skillId}`).slice(0, 12)}`,
      now: "2026-06-11T00:07:45.000Z",
      ...tenantContext({
        actor_id: "integration-api-tool-runner",
        roles: ["agent"],
        request_id: "req-postgres-proof-api-tool-after-forge",
        correlation_id: "corr-postgres-proof-api-tool-after-forge",
      }),
    });
    expect(rejectedApiToolRun?.isError).toBe(true);
    expect(rejectedApiToolRun?.structuredContent).toEqual(expect.objectContaining({
      error: "dojo_proof_evidence_ledger_resolution_failed",
      skill_id: skillId,
      requested_action: "run_workflow",
      proof_capsule_id: issuedContent.proof_capsule.capsule_id,
      proof_not_consumed: true,
      blocked_by: expect.arrayContaining(["evidence_checkpoint_record_count_mismatch"]),
      error_codes: ["proof_evidence_claim_unverified"],
    }));

    const proofRecordAfterRejectedRun = await pool.query<{ status: string; first_used_at: Date | null }>(
      `SELECT status, first_used_at
      FROM dojo_proof_records
      WHERE tenant_id = $1 AND workspace_id = $2 AND capsule_id = $3`,
      [tenantId, workspaceId, issuedContent.proof_capsule.capsule_id]
    );
    expect(proofRecordAfterRejectedRun.rows).toHaveLength(1);
    expect(proofRecordAfterRejectedRun.rows[0]).toEqual(expect.objectContaining({
      status: "issued",
      first_used_at: null,
    }));
    } finally {
      await apiServer.close();
    }
  }, 30_000);

  function tenantContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      tenant_id: tenantId,
      organization_id: organizationId,
      workspace_id: workspaceId,
      actor_id: "integration-agent",
      actor_type: "agent",
      roles: ["agent"],
      request_id: "req-postgres-proof",
      correlation_id: "corr-postgres-proof",
      ...overrides,
    };
  }
});

function recordOpenDetailsWorkflow(url = "https://app.example.test/settings"): void {
  const origin = new URL(url).origin;
  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
  browserBroker.selectTab("tab-a");
  expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
  registerSourceToken("details.open");
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin,
    action: "click",
    element: { role: "button", name: "Open details", source_id: "details.open" },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
    ],
  });
}

async function seedSkillRow(
  pool: Pool,
  input: {
    tenant_id: string;
    organization_id: string;
    workspace_id: string;
    skill_id: string;
    workflow_id: string;
    skill_name: string;
    skill_json: unknown;
    app_origin: string;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO dojo_tenants (tenant_id, organization_id, display_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (tenant_id) DO NOTHING`,
    [input.tenant_id, input.organization_id, input.tenant_id]
  );
  await pool.query(
    `INSERT INTO dojo_workspaces (tenant_id, workspace_id, organization_id, app_origin)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, workspace_id) DO NOTHING`,
    [input.tenant_id, input.workspace_id, input.organization_id, input.app_origin]
  );
  await pool.query(
    `INSERT INTO dojo_skills (tenant_id, workspace_id, skill_id, workflow_id, name, status, current_skill_version, skill_json)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    ON CONFLICT (tenant_id, skill_id) DO UPDATE SET
      workspace_id = EXCLUDED.workspace_id,
      workflow_id = EXCLUDED.workflow_id,
      name = EXCLUDED.name,
      status = EXCLUDED.status,
      current_skill_version = EXCLUDED.current_skill_version,
      skill_json = EXCLUDED.skill_json,
      updated_at = now()`,
    [
      input.tenant_id,
      input.workspace_id,
      input.skill_id,
      input.workflow_id,
      input.skill_name,
      "published",
      "skill_v1",
      JSON.stringify(input.skill_json),
    ]
  );
}

function registerSourceToken(token: string): void {
  const filePath = `src/${token}.tsx`;
  sourceIdentityRegistry.register({
    workspaceId: "workspace-a",
    filePath,
    adapter: "integration-test",
    transformVersion: "integration_source_identity_v1",
    tokens: [{ token, file: filePath, tag: "button", line: 1, column: 1 }],
  });
}

async function startApiToolHttpServer(response: {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{
  origin: string;
  requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
  }> = [];
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: { ...request.headers },
        body: parseJsonBody(rawBody),
      });
      reply.statusCode = response.status;
      const headers = response.headers ?? {};
      for (const [key, value] of Object.entries(headers)) reply.setHeader(key, value);
      if (response.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        reply.setHeader("content-type", "application/json");
      }
      reply.end(response.body === undefined ? "" : JSON.stringify(response.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("api_tool_test_server_address_unavailable");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

function parseJsonBody(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
