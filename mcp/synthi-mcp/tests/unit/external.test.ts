import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveExternalTools,
  callExternalTool,
  isExternalToolName,
  __resetExtCall,
  type AliasEntry,
} from "../../src/external/index.js";

const cfg = { id: "c1", name: "gh", url: "https://gh.example/mcp", allowlist: ["create_pr", "list_pr"] };

function fakeListTools(tools: { name: string; description?: string; inputSchema?: unknown }[]) {
  return async () => ({ ok: true as const, tools });
}

beforeEach(() => { __resetExtCall(); });

describe("isExternalToolName", () => {
  it("matches only ext_<n>", () => {
    expect(isExternalToolName("ext_0")).toBe(true);
    expect(isExternalToolName("ext_42")).toBe(true);
    expect(isExternalToolName("synthi_attach")).toBe(false);
    expect(isExternalToolName("ext_")).toBe(false);
  });
});

describe("resolveExternalTools", () => {
  it("is off (empty) when no config", async () => {
    const out = await resolveExternalTools({} as NodeJS.ProcessEnv, {
      readExternalConfig: () => null,
      listTools: fakeListTools([]),
      fetchConfigs: async () => [],
    });
    expect(out).toEqual({ descriptors: [], aliasMap: {} });
  });

  it("builds ext_<i> descriptors for allowlisted tools only", async () => {
    const out = await resolveExternalTools({} as NodeJS.ProcessEnv, {
      readExternalConfig: () => ({ apiUrl: "https://app", pat: "synthi_pat_x" }),
      fetchConfigs: async () => [cfg],
      listTools: fakeListTools([
        { name: "create_pr", description: "Open a PR", inputSchema: { type: "object" } },
        { name: "secret_tool", description: "not allowlisted" },
      ]),
    });
    expect(out.descriptors).toHaveLength(1);
    expect(out.descriptors[0]).toMatchObject({ name: "ext_0", description: "[gh] Open a PR" });
    expect(out.aliasMap["ext_0"]).toMatchObject({ connId: "c1", connName: "gh", toolName: "create_pr" });
  });

  it("degrades to empty when resolve throws", async () => {
    const out = await resolveExternalTools({} as NodeJS.ProcessEnv, {
      readExternalConfig: () => ({ apiUrl: "https://app", pat: "synthi_pat_x" }),
      fetchConfigs: async () => { throw new Error("network"); },
      listTools: fakeListTools([]),
    });
    expect(out).toEqual({ descriptors: [], aliasMap: {} });
  });
});

describe("callExternalTool", () => {
  const aliasMap: Record<string, AliasEntry> = {
    ext_0: { connId: "c1", connName: "gh", toolName: "create_pr", config: cfg },
  };

  it("routes a known alias through the hub and audits ok", async () => {
    const audits: any[] = [];
    const res = await callExternalTool("ext_0", { title: "x" }, aliasMap, {} as NodeJS.ProcessEnv, {
      callTool: async () => ({ ok: true as const, data: { number: 7 } }),
      postAudit: async (_e, row) => { audits.push(row); },
    });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ number: 7 });
    expect(audits[0]).toMatchObject({ alias: "ext_0", outcome: "ok", argsHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("returns isError + audits error for an unknown alias", async () => {
    const audits: any[] = [];
    const res = await callExternalTool("ext_99", {}, aliasMap, {} as NodeJS.ProcessEnv, {
      callTool: async () => ({ ok: true as const, data: {} }),
      postAudit: async (_e, row) => { audits.push(row); },
    });
    expect(res.isError).toBe(true);
    expect(audits[0]).toMatchObject({ outcome: "error", errorCode: "unknown_alias" });
  });

  it("returns isError + audits error when the hub call fails", async () => {
    const res = await callExternalTool("ext_0", {}, aliasMap, {} as NodeJS.ProcessEnv, {
      callTool: async () => ({ ok: false as const, error: { code: "tool_error", message: "boom" } }),
      postAudit: async () => {},
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].type === "text" ? res.content[0].text : "{}")).toMatchObject({ error: "external_tool_failed", code: "tool_error" });
  });

  it("blocks past the per-process extcall limit", async () => {
    process.env["SYNTHI_MCP_EXTCALL_LIMIT"] = "1";
    __resetExtCall();
    const call = () => callExternalTool("ext_0", {}, aliasMap, {} as NodeJS.ProcessEnv, {
      callTool: async () => ({ ok: true as const, data: {} }),
      postAudit: async () => {},
    });
    await call();
    const blocked = await call();
    expect(blocked.isError).toBe(true);
    expect(JSON.parse(blocked.content[0].type === "text" ? blocked.content[0].text : "{}").error).toBe("rate_limited");
    delete process.env["SYNTHI_MCP_EXTCALL_LIMIT"];
  });
});
