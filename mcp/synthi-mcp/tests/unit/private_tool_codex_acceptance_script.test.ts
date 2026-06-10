// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  CODEX_ACCEPTANCE_DISABLED_FEATURES,
  DEFAULT_CODEX_ACCEPTANCE_MODEL,
  buildCodexProcessEnv,
  buildCodexConfigToml,
  buildCodexAcceptancePrompt,
  codexExecArgs,
  extractCodexMcpEvidence,
  findPageWithText,
  selectCdpTargetsToClose,
  visualProofScreenshotOptions,
} from "../../scripts/private-tool-codex-acceptance.mjs";

describe("private-tool Codex acceptance harness", () => {
  it("defaults Codex acceptance to the 5.3-codex-spark model", () => {
    expect(DEFAULT_CODEX_ACCEPTANCE_MODEL).toBe("gpt-5.3-codex-spark");
  });

  it("configures Codex through the hosted browser runtime path", () => {
    const config = buildCodexConfigToml({
      codexReasoning: "low",
      codexModel: "gpt-5.3-codex-spark",
      distIndex: "/repo/mcp/synthi-mcp/dist/index.js",
      storeFile: "/tmp/private-tools.enc.json",
      storeKey: "private-tool-key",
      storeScope: "acceptance-scope",
      cdpUrl: "ws://runtime.example.test/devtools/browser/session",
      targetUrl: "https://preview.example.test/workspace",
      workspaceId: "acceptance-workspace",
    });

    expect(config).toContain('model = "gpt-5.3-codex-spark"');
    expect(config).toContain("SYNTHI_HOSTED_BROWSER_CDP_URL");
    expect(config).toContain("SYNTHI_HOSTED_BROWSER_WORKSPACE_URL");
    expect(config).toContain("SYNTHI_WORKSPACE_ID");
    expect(config).not.toContain("SYNTHI_BROWSER_CDP_URL");
    expect(config).not.toMatch(/browser-mcp-live|\/port\/\d+|C:\\\\/i);
  });

  it("writes the configured default model into Codex config", () => {
    const config = buildCodexConfigToml({
      codexReasoning: "low",
      codexModel: DEFAULT_CODEX_ACCEPTANCE_MODEL,
      distIndex: "/repo/mcp/synthi-mcp/dist/index.js",
      storeFile: "/tmp/private-tools.enc.json",
      storeKey: "private-tool-key",
      storeScope: "acceptance-scope",
      cdpUrl: "ws://runtime.example.test/devtools/browser/session",
      targetUrl: "https://preview.example.test/workspace",
      workspaceId: "acceptance-workspace",
    });

    expect(config.split("\n")[0]).toBe('model = "gpt-5.3-codex-spark"');
    expect(config).not.toContain("gpt-5.5");
  });

  it("prompts Codex to call the discovered private workflow tool instead of replaying manually", () => {
    const prompt = buildCodexAcceptancePrompt({
      targetUrl: "https://preview.example.test/workspace",
    });

    expect(prompt).toContain("synthi_browser_list_private_tools first");
    expect(prompt).toContain("tools[0].tool_name");
    expect(prompt).toContain("directly call the discovered synthi_app_* private workflow tool");
    expect(prompt).toContain("Do not call synthi_browser_begin_teach");
    expect(prompt).toContain("Do not use synthi_browser_action to manually click");
    expect(prompt).toContain("Only after that private workflow tool returns ok=true");
    expect(prompt).toContain("https://preview.example.test/workspace");
    expect(prompt).not.toContain("synthi_app_open_details");
  });

  it("runs Codex acceptance with unrelated built-in surfaces disabled", () => {
    const args = codexExecArgs({
      codexWorkdir: "/tmp/codex-workspace",
      prompt: "Use the saved workflow.",
    });

    const disabledFeatures = args
      .flatMap((arg, index) => arg === "--disable" ? [args[index + 1]] : [])
      .filter(Boolean);
    expect(disabledFeatures).toEqual(CODEX_ACCEPTANCE_DISABLED_FEATURES);
    expect(args).toContain("--json");
    expect(args).toContain("/tmp/codex-workspace");
    expect(args.at(-1)).toBe("Use the saved workflow.");
  });

  it("requires hosted workspace attach evidence instead of local CDP attach", () => {
    const toolName = "synthi_app_open_details";
    const targetUrl = "https://preview.example.test/workspace";
    const evidence = extractCodexMcpEvidence({
      toolName,
      targetUrl,
      events: [
        completedCall("synthi_browser_attach_current_workspace", { workspace_url: targetUrl }, {
          ok: true,
          opened_workspace_url: targetUrl,
        }),
        completedCall("synthi_browser_request_consent", { url: targetUrl }),
        completedCall(toolName, {}, {
          ok: true,
          private_tool: { tool_name: toolName },
          replay: { status: "passed", steps_run: 1 },
        }),
      ],
    });

    expect(evidence).toEqual(expect.objectContaining({
      attach_call: true,
      hosted_attach_call: true,
      local_attach_call: false,
      consent_call: true,
      open_call: true,
      opened_by_hosted_attach: true,
      private_tool_call: true,
      private_tool_result_ok: true,
      private_tool_steps_run: 1,
      command_execution_count: 0,
      command_executions: [],
    }));

    const localAttachEvidence = extractCodexMcpEvidence({
      toolName,
      targetUrl,
      events: [completedCall("synthi_browser_attach", {})],
    });
    expect(localAttachEvidence.hosted_attach_call).toBe(false);
    expect(localAttachEvidence.local_attach_call).toBe(true);
  });

  it("flags shell command execution so private-tool acceptance stays MCP-only", () => {
    const toolName = "synthi_app_open_details";
    const evidence = extractCodexMcpEvidence({
      toolName,
      targetUrl: "https://preview.example.test/workspace",
      events: [
        completedCall("synthi_browser_attach_current_workspace", {}),
        commandExecution("/bin/bash -lc 'cat generated.spec.ts'", 0),
        completedCall(toolName, {}, {
          ok: true,
          private_tool: { tool_name: toolName },
          replay: { status: "passed", steps_run: 1 },
        }),
      ],
    });

    expect(evidence.command_execution_count).toBe(1);
    expect(evidence.command_executions).toEqual([{
      status: "completed",
      exit_code: 0,
      command: "[redacted-command]",
    }]);
  });

  it("strips local CDP env from the Codex child process", () => {
    const env = buildCodexProcessEnv({
      codexHome: "/tmp/synthi-codex-home",
      baseEnv: {
        CODEX_HOME: "/tmp/original-codex-home",
        SYNTHI_BROWSER_CDP_URL: "ws://local-dev-cdp.example.test/devtools/browser/session",
        SYNTHI_HOSTED_BROWSER_CDP_URL: "ws://hosted-runtime.example.test/devtools/browser/session",
      },
    });

    expect(env.CODEX_HOME).toBe("/tmp/synthi-codex-home");
    expect(env.SYNTHI_HOSTED_BROWSER_CDP_URL).toBe("ws://hosted-runtime.example.test/devtools/browser/session");
    expect(env).not.toHaveProperty("SYNTHI_BROWSER_CDP_URL");
  });

  it("preserves one CDP page target while pruning stale pages", () => {
    const targets = [
      { id: "browser", type: "browser" },
      { id: "first-page", type: "page" },
      { id: "worker", type: "service_worker" },
      { id: "second-page", type: "page" },
      { id: "webview", type: "webview" },
    ];

    expect(selectCdpTargetsToClose([{ id: "only-page", type: "page" }])).toEqual([]);
    expect(selectCdpTargetsToClose(targets).map((target) => target.id)).toEqual(["second-page", "webview"]);
  });

  it("selects the matching page that shows visual proof text", async () => {
    const waitingPage = mockPage("https://preview.example.test/workspace", "Waiting for workflow");
    const donePage = mockPage("https://preview.example.test/workspace", "Details opened");
    const otherPage = mockPage("https://other.example.test/workspace", "Details opened");
    const postNavigationPage = mockPage("https://preview.example.test/workspace/details", "Details opened");

    const match = await findPageWithText({
      pages: [waitingPage, otherPage, postNavigationPage, donePage],
      targetUrl: "https://preview.example.test/workspace",
      expectedText: "Details opened",
    });

    expect(match?.page).toBe(donePage);
    expect(match?.text).toBe("Details opened");
    expect(match?.url).toBe("https://preview.example.test/workspace");
    expect(match?.match).toBe("exact-url");
  });

  it("accepts same-origin visual proof after in-app navigation", async () => {
    const postNavigationPage = mockPage("https://preview.example.test/workspace/details", "Details opened");
    const otherPage = mockPage("https://other.example.test/workspace/details", "Details opened");

    const match = await findPageWithText({
      pages: [otherPage, postNavigationPage],
      targetUrl: "https://preview.example.test/workspace",
      expectedText: "Details opened",
    });

    expect(match?.page).toBe(postNavigationPage);
    expect(match?.url).toBe("https://preview.example.test/workspace/details");
    expect(match?.match).toBe("same-origin");
  });

  it("keeps visual proof screenshots viewport-bounded with a capped timeout", () => {
    expect(visualProofScreenshotOptions({
      path: "/tmp/after.png",
      timeoutMs: 300_000,
    })).toEqual({
      path: "/tmp/after.png",
      fullPage: false,
      timeout: 60_000,
    });
    expect(visualProofScreenshotOptions({
      path: "/tmp/after.png",
      timeoutMs: 1,
    })).toEqual({
      path: "/tmp/after.png",
      fullPage: false,
      timeout: 5_000,
    });
  });
});

function completedCall(tool, args, structuredContent = {}) {
  return {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      status: "completed",
      tool,
      arguments: args,
      result: { structured_content: structuredContent },
    },
  };
}

function commandExecution(command, exitCode) {
  return {
    type: "item.completed",
    item: {
      type: "command_execution",
      status: "completed",
      command,
      exit_code: exitCode,
    },
  };
}

function mockPage(url, bodyText) {
  return {
    url: () => url,
    locator: () => ({
      innerText: async () => bodyText,
    }),
  };
}
