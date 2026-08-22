import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { CODESITE_TOOL_NAMES, CODESITE_TOOLS, dispatchCodeSiteTool } from "../../src/tools/codesite.js";

const originalEnv = { ...process.env };

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CodeSite MCP tool surface", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => mockJsonResponse({ ok: true })));
    process.env.SYNTHI_CODESITE_WORKSPACE = "workspace-env";
    process.env.SYNTHI_CODESITE_PROJECT_ID = "project-env";
    process.env.SYNTHI_CODESITE_BASE_URL = "http://codesite.test";
    delete process.env.SYNTHI_CODESITE_AGENT_SESSION_ID;
    delete process.env.SYNTHI_CODESITE_AGENT_TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  it("advertises every CodeSite tool in the capability registry", () => {
    for (const name of CODESITE_TOOL_NAMES) {
      expect(ADVERTISED_TOOLS).toContain(name);
      expect(CODESITE_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("returns null for non-CodeSite tool dispatch", async () => {
    expect(await dispatchCodeSiteTool("synthi_health", {})).toBeNull();
  });

  it("reads relevant context only from the environment-bound agent identity", async () => {
    process.env.SYNTHI_CODESITE_AGENT_SESSION_ID = "agent-1";
    process.env.SYNTHI_CODESITE_AGENT_TOKEN = "csa_scoped-agent-token";
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      contextVersion: "synthi.codesite.agentContext.v1",
      agent: { id: "agent-1" },
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_get_relevant_context", {});

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://codesite.test/api/workspace/workspace-env/codesite/agent-sessions/agent-1/relevant-context"),
      {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: "Bearer csa_scoped-agent-token",
        },
      },
    );
    expect(JSON.stringify(response)).not.toContain("csa_scoped-agent-token");
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      response: expect.objectContaining({ agent: { id: "agent-1" } }),
    }));
  });

  it("rejects caller-selected context identity before network access", async () => {
    process.env.SYNTHI_CODESITE_AGENT_SESSION_ID = "agent-1";
    process.env.SYNTHI_CODESITE_AGENT_TOKEN = "csa_scoped-agent-token";

    const response = await dispatchCodeSiteTool("synthi_codesite_get_relevant_context", {
      agent_session_id: "agent-forged",
      auth_token: "forged-token",
    });

    expect(response?.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "codesite_agent_context_arguments_forbidden",
    }));
  });

  it("requires the attached agent environment before requesting context", async () => {
    const response = await dispatchCodeSiteTool("synthi_codesite_get_relevant_context", {});
    expect(response?.isError).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "codesite_agent_context_environment_required",
    }));
  });

  it("reads radar state from the configured control-plane API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      projectId: "project-env",
      towerState: "holding",
      collisionForecast: { riskLevel: "high" },
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_get_radar", {});

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://codesite.test/api/workspace/workspace-env/codesite/projects/project-env/control-state"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_codesite_get_radar",
      response: expect.objectContaining({ towerState: "holding" }),
    }));
  });

  it("reads success metrics from the configured control-plane API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      metrics: {
        schemaVersion: "synthi.codesite.metrics.v1",
        summary: { codeSiteFsBlockedWrites: 1 },
      },
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_get_metrics", {});

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://codesite.test/api/workspace/workspace-env/codesite/projects/project-env/metrics"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_codesite_get_metrics",
      response: expect.objectContaining({
        metrics: expect.objectContaining({
          schemaVersion: "synthi.codesite.metrics.v1",
        }),
      }),
    }));
  });

  it("maps CodeSite project, agent session, member, policy setup, and manifest lifecycle routes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockJsonResponse({ projects: [{ id: "project-1" }] }))
      .mockResolvedValueOnce(mockJsonResponse({ project: { id: "project-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ project: { id: "project-1", zonePolicy: {} } }))
      .mockResolvedValueOnce(mockJsonResponse({ project: { id: "project-1", controlPlan: {} } }))
      .mockResolvedValueOnce(mockJsonResponse({ agentSession: { id: "agent-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ members: [{ id: "member-1" }] }))
      .mockResolvedValueOnce(mockJsonResponse({ member: { id: "member-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ member: { id: "member-1", status: "revoked" } }))
      .mockResolvedValueOnce(mockJsonResponse({ mcp_tools: ["synthi_codesite_file_flight_plan"] }))
      .mockResolvedValueOnce(mockJsonResponse({ schemas: {} }));

    await dispatchCodeSiteTool("synthi_codesite_list_projects", { workspace_slug: "acme", base_url: "http://localhost:3100/" });
    await dispatchCodeSiteTool("synthi_codesite_create_project", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      title: "Checkout hardening",
      request: "Coordinate schema, API, and QA agents",
    });
    await dispatchCodeSiteTool("synthi_codesite_update_zone_policy", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      zonePolicy: { restrictedAirspace: ["synthi/prisma/**"] },
    });
    await dispatchCodeSiteTool("synthi_codesite_update_control_plan", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      controlPlan: { towerMode: "strict" },
    });
    await dispatchCodeSiteTool("synthi_codesite_register_agent_session", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      providerSessionRef: "codex-SCHEMA-01",
      displayCallsign: "SCHEMA-01",
      permissions: ["file_flight_plan", "request_clearance"],
    });
    await dispatchCodeSiteTool("synthi_codesite_list_project_members", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
    });
    await dispatchCodeSiteTool("synthi_codesite_upsert_project_member", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      userId: "user-agent",
      role: "agent",
    });
    await dispatchCodeSiteTool("synthi_codesite_revoke_project_member", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      member_id: "member-1",
      reason: "session complete",
    });
    await dispatchCodeSiteTool("synthi_codesite_get_agent_manifest", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
    });
    await dispatchCodeSiteTool("synthi_codesite_get_schemas", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
    });

    expect(fetch).toHaveBeenNthCalledWith(1, new URL("http://localhost:3100/api/workspace/acme/codesite/projects"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(2, new URL("http://localhost:3100/api/workspace/acme/codesite/projects"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ title: "Checkout hardening", request: "Coordinate schema, API, and QA agents" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(3, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/zone-policy"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ zonePolicy: { restrictedAirspace: ["synthi/prisma/**"] } }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(4, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/control-plan"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ controlPlan: { towerMode: "strict" } }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(5, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/agent-sessions"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        providerSessionRef: "codex-SCHEMA-01",
        displayCallsign: "SCHEMA-01",
        permissions: ["file_flight_plan", "request_clearance"],
      }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(6, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/members"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(7, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/members"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ userId: "user-agent", role: "agent" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(8, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/members/member-1/revoke"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "session complete" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(9, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/agent-manifest"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(10, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/schemas"), expect.objectContaining({ method: "GET" }));
  });

  it("maps CodeSite governance permits, document reviews, and route revision workflows", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockJsonResponse({ permits: [{ id: "permit-1" }] }))
      .mockResolvedValueOnce(mockJsonResponse({ permit: { id: "permit-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ review: { id: "review-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ routeRevisions: [{ id: "rr-1" }] }))
      .mockResolvedValueOnce(mockJsonResponse({ routeRevision: { id: "rr-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ routeRevision: { id: "rr-1", status: "approved" } }))
      .mockResolvedValueOnce(mockJsonResponse({ routeRevision: { id: "rr-1", status: "applied" } }));

    await dispatchCodeSiteTool("synthi_codesite_list_permits", { workspace_slug: "acme", base_url: "http://localhost:3100/", project_id: "project-1" });
    await dispatchCodeSiteTool("synthi_codesite_issue_permit", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      executionPlanId: "plan-1",
      permitType: "restricted_route",
      scope: { routes: ["synthi/prisma/**"] },
      evidenceRefs: ["permit:evidence"],
    });
    await dispatchCodeSiteTool("synthi_codesite_review_document", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      document_id: "doc-1",
      decision: "approved",
      reviewTimeMs: 90_000,
      baselineReviewTimeMs: 300_000,
      evidenceRefs: ["review:evidence"],
    });
    await dispatchCodeSiteTool("synthi_codesite_list_route_revisions", { workspace_slug: "acme", base_url: "http://localhost:3100/", project_id: "project-1" });
    await dispatchCodeSiteTool("synthi_codesite_propose_route_revision", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      execution_plan_id: "plan-1",
      proposedRoute: ["synthi/src/**"],
      reason: "handoff to API agent",
    });
    await dispatchCodeSiteTool("synthi_codesite_review_route_revision", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      route_revision_id: "rr-1",
      decision: "approved",
    });
    await dispatchCodeSiteTool("synthi_codesite_apply_route_revision", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      route_revision_id: "rr-1",
      appliedBy: "tower",
    });

    expect(fetch).toHaveBeenNthCalledWith(1, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/permits"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(2, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/permits"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        executionPlanId: "plan-1",
        permitType: "restricted_route",
        scope: { routes: ["synthi/prisma/**"] },
        evidenceRefs: ["permit:evidence"],
      }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(3, new URL("http://localhost:3100/api/workspace/acme/codesite/documents/doc-1/reviews"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        decision: "approved",
        reviewTimeMs: 90_000,
        baselineReviewTimeMs: 300_000,
        evidenceRefs: ["review:evidence"],
      }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(4, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/route-revisions"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(5, new URL("http://localhost:3100/api/workspace/acme/codesite/execution-plans/plan-1/route-revisions"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ proposedRoute: ["synthi/src/**"], reason: "handoff to API agent" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(6, new URL("http://localhost:3100/api/workspace/acme/codesite/route-revisions/rr-1/review"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ decision: "approved" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(7, new URL("http://localhost:3100/api/workspace/acme/codesite/route-revisions/rr-1/apply"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ appliedBy: "tower" }),
    }));
  });

  it("maps CodeSite mayday, policy delta, proof bundle, landing, active-state, and artifact operator routes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockJsonResponse({ active: true }))
      .mockResolvedValueOnce(mockJsonResponse({ activeTransactions: [{ id: "txn-1" }] }))
      .mockResolvedValueOnce(mockJsonResponse({ mutationLease: { id: "lease-1", status: "revoked" } }))
      .mockResolvedValueOnce(mockJsonResponse({ policyDecision: { id: "decision-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ transaction: { id: "txn-1", status: "aborted" } }))
      .mockResolvedValueOnce(mockJsonResponse({ incident: { id: "incident-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ incidentReplay: { incidentId: "incident-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ incident: { id: "incident-1", status: "resolved" } }))
      .mockResolvedValueOnce(mockJsonResponse({ policyDelta: { id: "delta-1", promotionState: "proposed" } }))
      .mockResolvedValueOnce(mockJsonResponse({ policyDelta: { id: "delta-1", promotionState: "active" } }))
      .mockResolvedValueOnce(mockJsonResponse({ policyDelta: { id: "delta-2", promotionState: "rejected" } }))
      .mockResolvedValueOnce(mockJsonResponse({ inspectionRun: { id: "landing-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ inspectionRun: { id: "landing-1", status: "passed" } }))
      .mockResolvedValueOnce(mockJsonResponse({ artifacts: [{ path: "codesite/manifest.json" }] }))
      .mockResolvedValueOnce(mockJsonResponse({ proofBundle: { id: "bundle-1" } }))
      .mockResolvedValueOnce(mockJsonResponse({ proofBundle: { id: "bundle-1", commitSha: "abc1234" } }));

    await dispatchCodeSiteTool("synthi_codesite_get_active_state", { workspace_slug: "acme", base_url: "http://localhost:3100/" });
    await dispatchCodeSiteTool("synthi_codesite_list_active_transactions", { workspace_slug: "acme", base_url: "http://localhost:3100/" });
    await dispatchCodeSiteTool("synthi_codesite_revoke_clearance", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      mutation_lease_id: "lease-1",
      reason: "operator takeover",
    });
    await dispatchCodeSiteTool("synthi_codesite_record_policy_decision", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      mutation_lease_id: "lease-1",
      decision: "hold",
      reasonCodes: ["operator_hold"],
    });
    await dispatchCodeSiteTool("synthi_codesite_abort_transaction", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      transaction_id: "txn-1",
      reason: "stale base",
    });
    await dispatchCodeSiteTool("synthi_codesite_declare_mayday", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      severity: "critical",
      summary: "Production migration drift",
    });
    await dispatchCodeSiteTool("synthi_codesite_get_incident_replay", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      incident_id: "incident-1",
    });
    await dispatchCodeSiteTool("synthi_codesite_resume_mayday", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      incident_id: "incident-1",
      resolution: "Rollback verified",
      replayRefs: ["replay:1"],
    });
    await dispatchCodeSiteTool("synthi_codesite_file_policy_delta", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      learnedFromIncidents: ["incident-1"],
      ruleCandidate: { reasonCode: "schema_first_required" },
    });
    await dispatchCodeSiteTool("synthi_codesite_promote_policy_delta", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      policy_delta_id: "delta-1",
      validationStatus: "passed",
      replayRefs: ["replay:1"],
    });
    await dispatchCodeSiteTool("synthi_codesite_reject_policy_delta", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      policy_delta_id: "delta-2",
      reason: "too broad",
    });
    await dispatchCodeSiteTool("synthi_codesite_request_landing", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      executionPlanId: "plan-1",
      changedPaths: ["synthi/src/**"],
    });
    await dispatchCodeSiteTool("synthi_codesite_complete_landing", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      inspection_run_id: "landing-1",
      status: "passed",
      evidenceRefs: ["ci:green"],
    });
    await dispatchCodeSiteTool("synthi_codesite_preview_artifacts", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "project-1",
      include: "content",
      max_content_bytes: 4096,
    });
    await dispatchCodeSiteTool("synthi_codesite_get_proof_bundle", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      bundle_id: "bundle-1",
    });
    await dispatchCodeSiteTool("synthi_codesite_attach_proof_bundle_commit", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      bundle_id: "bundle-1",
      commitSha: "abc1234",
      trailers: { "CodeSite-Proof": "bundle-1" },
    });

    expect(fetch).toHaveBeenNthCalledWith(1, new URL("http://localhost:3100/api/workspace/acme/codesite/active-state"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(2, new URL("http://localhost:3100/api/workspace/acme/codesite/transactions/active"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(3, new URL("http://localhost:3100/api/workspace/acme/codesite/mutation-leases/lease-1/revoke"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "operator takeover" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(4, new URL("http://localhost:3100/api/workspace/acme/codesite/mutation-leases/lease-1/policy-decisions"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ decision: "hold", reasonCodes: ["operator_hold"] }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(5, new URL("http://localhost:3100/api/workspace/acme/codesite/transactions/txn-1/abort"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "stale base" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(6, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/incidents"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ severity: "critical", summary: "Production migration drift", category: "mayday" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(7, new URL("http://localhost:3100/api/workspace/acme/codesite/incidents/incident-1/replay"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(8, new URL("http://localhost:3100/api/workspace/acme/codesite/incidents/incident-1/resume"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ resolution: "Rollback verified", replayRefs: ["replay:1"] }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(9, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/policy-deltas"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ learnedFromIncidents: ["incident-1"], ruleCandidate: { reasonCode: "schema_first_required" } }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(10, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/policy-deltas/delta-1/promote"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ validationStatus: "passed", replayRefs: ["replay:1"] }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(11, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/policy-deltas/delta-2/reject"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "too broad" }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(12, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/inspection-runs"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ executionPlanId: "plan-1", changedPaths: ["synthi/src/**"] }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(13, new URL("http://localhost:3100/api/workspace/acme/codesite/inspection-runs/landing-1/complete"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ status: "passed", evidenceRefs: ["ci:green"] }),
    }));
    expect(fetch).toHaveBeenNthCalledWith(14, new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/artifacts/preview?include=content&maxContentBytes=4096"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(15, new URL("http://localhost:3100/api/workspace/acme/codesite/proof-bundles/bundle-1"), expect.objectContaining({ method: "GET" }));
    expect(fetch).toHaveBeenNthCalledWith(16, new URL("http://localhost:3100/api/workspace/acme/codesite/proof-bundles/bundle-1/commit"), expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ commitSha: "abc1234", trailers: { "CodeSite-Proof": "bundle-1" } }),
    }));
  });

  it("records write paths with product-language arguments", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      ok: true,
      transaction: { id: "txn-1", status: "open" },
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_record_write", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      transaction_id: "txn-1",
      file_path: "synthi/prisma/schema.prisma",
      tool: "apply_patch",
    });

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://localhost:3100/api/workspace/acme/codesite/transactions/txn-1/record-write"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tool: "apply_patch", path: "synthi/prisma/schema.prisma" }),
      }),
    );
  });

  it("preflights CodeSiteFS writes before external adapters mutate files", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      ok: false,
      disposition: "write_denied",
      reasonCodes: ["active_clearance_required"],
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_preflight_write", {
      workspace_slug: "acme",
      project_id: "project-1",
      base_url: "http://localhost:3100/",
      file_path: "backend/collab-server/terminalService.js",
      source: "runtime_pod_terminal",
      tool: "terminal_exec",
      mutation_lease_id: "lease-1",
      processAncestry: ["runtime-pod", "bash"],
      evidenceRefs: ["runtime:event:write-intent-1"],
    });

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://localhost:3100/api/workspace/acme/codesite/projects/project-1/codesitefs-events"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          source: "runtime_pod_terminal",
          tool: "terminal_exec",
          processAncestry: ["runtime-pod", "bash"],
          evidenceRefs: ["runtime:event:write-intent-1"],
          path: "backend/collab-server/terminalService.js",
          mutationLeaseId: "lease-1",
        }),
      }),
    );
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_codesite_preflight_write",
      response: expect.objectContaining({
        disposition: "write_denied",
        reasonCodes: ["active_clearance_required"],
      }),
    }));
  });

  it("applies patches through collab-server only after CodeSite dry-run approval", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockJsonResponse({
        results: [{ ok: true, transaction: { id: "txn-1" } }],
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        success: true,
        written: ["synthi/src/app/page.jsx"],
      }));

    const response = await dispatchCodeSiteTool("synthi_codesite_apply_patch", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      collab_base_url: "http://collab.test/",
      transaction_id: "txn-1",
      mutation_lease_id: "lease-1",
      user_id: "user-1",
      files: [{ path: "synthi/src/app/page.jsx", content: "export default function Page() {}" }],
      allowedPaths: ["synthi/src/**"],
    });

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("http://localhost:3100/api/workspace/acme/codesite/transactions/txn-1/dry-run-patch"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          files: [{ path: "synthi/src/app/page.jsx", content: "export default function Page() {}" }],
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("http://collab.test/git/acme/write-files-batch"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-codesite-transaction-id": "txn-1",
          "x-codesite-control-plane-url": "http://localhost:3100/api/workspace/acme/codesite",
          "x-user-id": "user-1",
        }),
      }),
    );
    const collabBody = JSON.parse(String(vi.mocked(fetch).mock.calls[1][1]?.body));
    expect(collabBody).toMatchObject({
      files: [{ path: "synthi/src/app/page.jsx", content: "export default function Page() {}" }],
      userId: "user-1",
      codesite: {
        enforce: true,
        transactionId: "txn-1",
        mutationLeaseId: "lease-1",
        controlPlaneUrl: "http://localhost:3100/api/workspace/acme/codesite",
        allowedPaths: ["synthi/src/**"],
        processAncestry: ["mcp:synthi_codesite_apply_patch"],
      },
    });
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_codesite_apply_patch",
      apply: expect.objectContaining({ success: true }),
    }));
  });

  it("does not apply patches when CodeSite dry-run rejects a write", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      results: [{ ok: false, policyDecision: { decision: "block", reasonCodes: ["outside_clearance_route"] } }],
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_apply_patch", {
      transaction_id: "txn-1",
      files: [{ path: "secrets/.env", content: "TOKEN=bad" }],
    });

    expect(response?.isError).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "codesite_patch_policy_denied",
      transaction_id: "txn-1",
    }));
  });

  it("polls per-agent inbox items separately from project events", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      inbox: [
        { id: "item-acked", eventId: "evt-1", acknowledgedAt: "2026-06-30T00:00:00.000Z" },
        { id: "item-open", eventId: "evt-2", acknowledgedAt: null },
      ],
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_get_inbox", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      agent_session_id: "agent-1",
    });

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://localhost:3100/api/workspace/acme/codesite/agent-sessions/agent-1/inbox"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_codesite_get_inbox",
      next_inbox_item: expect.objectContaining({ id: "item-open" }),
      inbox_count: 2,
    }));
  });

  it("reads line provenance by project, file, and line number", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      lineProvenance: [{ id: "line-1", filePath: "api/checkout/route.js", startLine: 42 }],
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_get_line_provenance", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      project_id: "proj-1",
      file_path: "api/checkout/route.js",
      line_number: 42,
    });

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://localhost:3100/api/workspace/acme/codesite/provenance/line?projectId=proj-1&filePath=api%2Fcheckout%2Froute.js&lineNumber=42"),
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("reviews quarantine manifests through the CodeSite control-plane facade", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({
      quarantines: [{ quarantineId: "qtn-1", status: "reviewable" }],
    }));

    const response = await dispatchCodeSiteTool("synthi_codesite_review_quarantine", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      transaction_id: "txn-1",
      status: "reviewable",
    });

    expect(response?.isError).toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://localhost:3100/api/workspace/acme/codesite/quarantines?transactionId=txn-1&status=reviewable"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      ok: true,
      tool: "synthi_codesite_review_quarantine",
      response: expect.objectContaining({
        quarantines: [expect.objectContaining({ quarantineId: "qtn-1" })],
      }),
    }));
  });

  it("replays and applies selected quarantine paths through the CodeSite API surface", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockJsonResponse({
        ok: true,
        replay: [{ path: "docs/review.md" }],
        rejected: [],
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        ok: true,
        applied: [{ path: "docs/review.md" }],
      }));

    const replay = await dispatchCodeSiteTool("synthi_codesite_replay_quarantine", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      quarantine_id: "qtn-1",
      transaction_id: "txn-1",
      mutation_lease_id: "lease-1",
      user_id: "agent-user",
      filesystem_user_id: "runtime-user",
      runtime_scope: "terminal",
      selected_paths: ["docs/review.md"],
    });
    const apply = await dispatchCodeSiteTool("synthi_codesite_apply_quarantine", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      quarantine_id: "qtn-1",
      transaction_id: "txn-1",
      mutation_lease_id: "lease-1",
      user_id: "agent-user",
      filesystem_user_id: "runtime-user",
      runtime_scope: "terminal",
      selected_paths: ["docs/review.md"],
    });

    expect(replay?.isError).toBeUndefined();
    expect(apply?.isError).toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("http://localhost:3100/api/workspace/acme/codesite/quarantines/qtn-1/replay"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          transactionId: "txn-1",
          paths: ["docs/review.md"],
          mutationLeaseId: "lease-1",
          userId: "agent-user",
          filesystemUserId: "runtime-user",
          runtimeScope: "terminal",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("http://localhost:3100/api/workspace/acme/codesite/quarantines/qtn-1/apply"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          transactionId: "txn-1",
          paths: ["docs/review.md"],
          mutationLeaseId: "lease-1",
          userId: "agent-user",
          filesystemUserId: "runtime-user",
          runtimeScope: "terminal",
        }),
      }),
    );
  });

  it("fails quarantine replay before fetch when no selected paths are provided", async () => {
    const replay = await dispatchCodeSiteTool("synthi_codesite_replay_quarantine", {
      workspace_slug: "acme",
      base_url: "http://localhost:3100/",
      quarantine_id: "qtn-1",
      transaction_id: "txn-1",
    });

    expect(replay?.isError).toBe(true);
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      error: "codesite_tool_failed",
      message: "missing_selected_paths",
    }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps RFI and mayday tools to structured document and incident routes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockJsonResponse({ document: { kind: "rfi" } }))
      .mockResolvedValueOnce(mockJsonResponse({ incident: { category: "mayday" } }));

    const rfi = await dispatchCodeSiteTool("synthi_codesite_file_rfi", {
      title: "Need schema owner",
      body: { question: "Who owns signup schema?" },
    });
    const mayday = await dispatchCodeSiteTool("synthi_codesite_declare_mayday", {
      severity: "critical",
      summary: "Destructive migration detected",
    });

    expect(rfi?.isError).toBeUndefined();
    expect(mayday?.isError).toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL("http://codesite.test/api/workspace/workspace-env/codesite/projects/project-env/documents"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "Need schema owner", question: "Who owns signup schema?", kind: "rfi" }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("http://codesite.test/api/workspace/workspace-env/codesite/projects/project-env/incidents"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ severity: "critical", summary: "Destructive migration detected", category: "mayday" }),
      }),
    );
  });

  it("surfaces control-plane failures as MCP errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockJsonResponse({ error: "transaction_not_found" }, 404));

    const response = await dispatchCodeSiteTool("synthi_codesite_get_transaction_status", {
      transaction_id: "txn-missing",
    });

    expect(response?.isError).toBe(true);
    expect(response?.structuredContent).toEqual(expect.objectContaining({
      error: "codesite_control_plane_request_failed",
      status: 404,
      response: { error: "transaction_not_found" },
    }));
  });
});
