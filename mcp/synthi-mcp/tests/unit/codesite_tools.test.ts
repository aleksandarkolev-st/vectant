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
