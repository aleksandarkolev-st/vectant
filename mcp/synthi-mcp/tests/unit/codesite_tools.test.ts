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
