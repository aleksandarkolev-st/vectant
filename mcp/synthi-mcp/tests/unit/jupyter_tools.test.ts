import { describe, expect, it } from "vitest";
import { JUPYTER_TOOLS, dispatchJupyterTool, isJupyterToolName } from "../../src/tools/jupyter.js";

const config = {
  SYNTHI_API_URL: "https://app.example",
  SYNTHI_PAT: "synthi_pat_x",
  SYNTHI_WORKSPACE_SLUG: "team",
} as NodeJS.ProcessEnv;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function capture(response: Response) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("Jupyter MCP tools", () => {
  it("recognizes only the registered Jupyter tools", () => {
    expect(isJupyterToolName("synthi_jupyter_execute_cells")).toBe(true);
    expect(isJupyterToolName("synthi_exec_in_runtime")).toBe(false);
  });

  it("lists registered servers through the PAT-gated bridge without credentials", async () => {
    const { calls, fetch } = capture(jsonResponse(200, { servers: [{ id: "server-1", hasToken: true }] }));
    const result = await dispatchJupyterTool("synthi_jupyter_list_servers", {}, config, { fetch });
    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({ servers: [{ id: "server-1", hasToken: true }] });
    expect(calls[0].url).toBe("https://app.example/api/integrations/mcp/jupyter?workspaceSlug=team");
    expect(calls[0].init?.headers).toMatchObject({ authorization: "Bearer synthi_pat_x" });
  });

  it("reads a notebook snapshot with only the selected server and path", async () => {
    const { calls, fetch } = capture(jsonResponse(200, { revision: "r1", notebook: { cells: [] } }));
    const result = await dispatchJupyterTool("synthi_jupyter_snapshot_notebook", { serverId: "server-1", path: "analysis.ipynb" }, config, { fetch });
    expect(result?.isError).toBeFalsy();
    expect(calls[0].url).toContain("operation=snapshot");
    expect(calls[0].url).toContain("serverId=server-1");
    expect(calls[0].url).toContain("path=analysis.ipynb");
  });

  it("executes bounded cell code through the write-gated operation", async () => {
    const { calls, fetch } = capture(jsonResponse(200, { kernelId: "kernel-1", outputs: [] }));
    const result = await dispatchJupyterTool("synthi_jupyter_execute_cells", { serverId: "server-1", path: "analysis.ipynb", code: "print(1)" }, config, { fetch });
    expect(result?.isError).toBeFalsy();
    expect(calls[0].url).toBe("https://app.example/api/integrations/mcp/jupyter");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toMatchObject({ operation: "execute", workspaceSlug: "team", serverId: "server-1", path: "analysis.ipynb", code: "print(1)" });
  });

  it("requires the identifiers needed to scope a kernel mutation", async () => {
    const { fetch } = capture(jsonResponse(200, {}));
    const result = await dispatchJupyterTool("synthi_jupyter_restart_kernel", { serverId: "server-1" }, config, { fetch });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ error: "kernel_required" });
  });

  it("preserves conflict errors from notebook save", async () => {
    const { fetch } = capture(jsonResponse(409, { error: "server_newer" }));
    const result = await dispatchJupyterTool("synthi_jupyter_save_notebook", { serverId: "server-1", path: "analysis.ipynb", notebook: { cells: [] } }, config, { fetch });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ error: "server_newer", status: 409 });
  });

  it("advertises every Jupyter operation with a schema", () => {
    expect(JUPYTER_TOOLS.map((tool) => tool.name)).toEqual([
      "synthi_jupyter_list_servers",
      "synthi_jupyter_test_server",
      "synthi_jupyter_snapshot_notebook",
      "synthi_jupyter_execute_cells",
      "synthi_jupyter_save_notebook",
      "synthi_jupyter_interrupt_kernel",
      "synthi_jupyter_restart_kernel",
    ]);
    expect(JUPYTER_TOOLS.every((tool) => tool.inputSchema.type === "object")).toBe(true);
  });
});
