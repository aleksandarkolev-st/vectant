import { describe, it, expect } from "vitest";
import { dispatchProgramTool, isProgramToolName, PROGRAM_TOOLS } from "../../src/tools/programs.js";

const cfg = {
  SYNTHI_API_URL: "https://app.example",
  SYNTHI_PAT: "synthi_pat_x",
  SYNTHI_WORKSPACE_SLUG: "team",
} as unknown as NodeJS.ProcessEnv;

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function captureFetch(res: Response) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return res;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("isProgramToolName", () => {
  it("matches the program tools only", () => {
    expect(isProgramToolName("synthi_exec_in_runtime")).toBe(true);
    expect(isProgramToolName("synthi_screenshot")).toBe(false);
  });
});

describe("synthi_exec_in_runtime", () => {
  it("posts the command to the PAT-gated runtime-exec endpoint and returns output/exitCode", async () => {
    const { calls, fetchImpl } = captureFetch(
      jsonRes(200, { sessionId: "ai-1", output: "hello\n", exitCode: 0, timedOut: false }),
    );
    const res = await dispatchProgramTool(
      "synthi_exec_in_runtime",
      { command: "echo hello" },
      cfg,
      { fetch: fetchImpl },
    );
    expect(res).not.toBeNull();
    expect(res!.isError).toBeFalsy();
    expect(res!.structuredContent).toMatchObject({ output: "hello\n", exitCode: 0, timedOut: false, sessionId: "ai-1" });
    expect(calls[0].url).toBe("https://app.example/api/integrations/mcp/runtime-exec");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.authorization).toBe("Bearer synthi_pat_x");
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ workspaceSlug: "team", command: "echo hello" });
  });

  it("accepts an explicit workspaceSlug arg over the env default", async () => {
    const { calls, fetchImpl } = captureFetch(jsonRes(200, { output: "", exitCode: 0 }));
    await dispatchProgramTool(
      "synthi_exec_in_runtime",
      { command: "ls", workspaceSlug: "other" },
      cfg,
      { fetch: fetchImpl },
    );
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ workspaceSlug: "other" });
  });

  it("returns not_configured when SYNTHI_API_URL/PAT are absent", async () => {
    const { fetchImpl } = captureFetch(jsonRes(200, {}));
    const res = await dispatchProgramTool(
      "synthi_exec_in_runtime",
      { command: "x" },
      {} as NodeJS.ProcessEnv,
      { fetch: fetchImpl },
    );
    expect(res!.isError).toBe(true);
    expect(res!.structuredContent).toMatchObject({ error: "not_configured" });
  });

  it("requires a command", async () => {
    const { fetchImpl } = captureFetch(jsonRes(200, {}));
    const res = await dispatchProgramTool("synthi_exec_in_runtime", {}, cfg, { fetch: fetchImpl });
    expect(res!.isError).toBe(true);
    expect(res!.structuredContent).toMatchObject({ error: "command_required" });
  });

  it("surfaces consent_required (409) from the endpoint", async () => {
    const { fetchImpl } = captureFetch(jsonRes(409, { error: "consent_required" }));
    const res = await dispatchProgramTool("synthi_exec_in_runtime", { command: "x" }, cfg, { fetch: fetchImpl });
    expect(res!.isError).toBe(true);
    expect(res!.structuredContent).toMatchObject({ error: "consent_required", status: 409 });
  });

  it("returns null for a non-program tool", async () => {
    const { fetchImpl } = captureFetch(jsonRes(200, {}));
    const res = await dispatchProgramTool("synthi_screenshot", {}, cfg, { fetch: fetchImpl });
    expect(res).toBeNull();
  });
});

describe("synthi_list_programs", () => {
  it("GETs the programs inventory (sessions + installed) with the bearer pat", async () => {
    const { calls, fetchImpl } = captureFetch(
      jsonRes(200, { sessions: [{ id: "ps-1", state: "running" }], installed: [{ id: "i1" }] }),
    );
    const res = await dispatchProgramTool("synthi_list_programs", {}, cfg, { fetch: fetchImpl });
    expect(res!.isError).toBeFalsy();
    expect(res!.structuredContent).toMatchObject({ sessions: [{ id: "ps-1" }], installed: [{ id: "i1" }] });
    expect(calls[0].url).toBe("https://app.example/api/integrations/mcp/programs?workspaceSlug=team");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers.authorization).toBe("Bearer synthi_pat_x");
  });

  it("surfaces forbidden (403) from the endpoint", async () => {
    const { fetchImpl } = captureFetch(jsonRes(403, { error: "forbidden" }));
    const res = await dispatchProgramTool("synthi_list_programs", {}, cfg, { fetch: fetchImpl });
    expect(res!.isError).toBe(true);
    expect(res!.structuredContent).toMatchObject({ error: "forbidden", status: 403 });
  });
});

describe("synthi_read_session", () => {
  it("requires a sessionId", async () => {
    const { fetchImpl } = captureFetch(jsonRes(200, {}));
    const res = await dispatchProgramTool("synthi_read_session", {}, cfg, { fetch: fetchImpl });
    expect(res!.isError).toBe(true);
    expect(res!.structuredContent).toMatchObject({ error: "session_required" });
  });

  it("GETs a single session + its events", async () => {
    const { calls, fetchImpl } = captureFetch(
      jsonRes(200, { session: { id: "ps-1", state: "running" }, events: [{ type: "launch_ack" }] }),
    );
    const res = await dispatchProgramTool("synthi_read_session", { sessionId: "ps-1" }, cfg, { fetch: fetchImpl });
    expect(res!.isError).toBeFalsy();
    expect(res!.structuredContent).toMatchObject({ session: { id: "ps-1" }, events: [{ type: "launch_ack" }] });
    expect(calls[0].url).toBe("https://app.example/api/integrations/mcp/programs/ps-1?workspaceSlug=team");
    expect(calls[0].init.method).toBe("GET");
  });
});

describe("PROGRAM_TOOLS", () => {
  it("advertises the three command-control tools with object input schemas", () => {
    for (const name of ["synthi_exec_in_runtime", "synthi_list_programs", "synthi_read_session"]) {
      const t = PROGRAM_TOOLS.find((x) => x.name === name);
      expect(t, name).toBeTruthy();
      expect(t!.inputSchema).toMatchObject({ type: "object" });
    }
  });
});
