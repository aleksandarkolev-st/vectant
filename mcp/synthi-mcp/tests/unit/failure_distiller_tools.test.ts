import { describe, expect, it, vi } from "vitest";
import { FAILURE_DISTILLER_TOOLS, dispatchFailureDistillerTool } from "../../src/tools/failure_distiller.js";

describe("Failure Distiller MCP tools", () => {
  it("advertises the complete agent capsule lifecycle", () => {
    expect(FAILURE_DISTILLER_TOOLS.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "synthi_failure_observation_capture", "synthi_failure_distill", "synthi_failure_capsule_replay",
      "synthi_failure_capsule_validate_patch", "synthi_failure_capsule_request_apply", "synthi_failure_capsule_apply_approved",
    ]));
  });

  it("forwards only opaque workspace and capsule identifiers to the engine", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, capsuleId: "capsule_aaaaaaaaaa" }), { status: 200 }));
    const result = await dispatchFailureDistillerTool("synthi_failure_capsule_replay", { workspaceRef: "team/user", capsuleId: "capsule_aaaaaaaaaa" }, { AI_BACKEND_URL: "http://engine:8000" }, fetchMock);
    expect(fetchMock).toHaveBeenCalledWith(new URL("http://engine:8000/heal/agentic/distill/run"), expect.objectContaining({ method: "POST", body: JSON.stringify({ workspaceRef: "team/user", capsuleId: "capsule_aaaaaaaaaa" }) }));
    expect(result?.structuredContent).toEqual({ ok: true, capsuleId: "capsule_aaaaaaaaaa" });
  });

  it("refuses calls without the active workspace reference", async () => {
    const result = await dispatchFailureDistillerTool("synthi_failure_distill", { command: "pytest", isolation: {} }, { AI_BACKEND_URL: "http://engine:8000" });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toEqual(expect.objectContaining({ error: "invalid_arguments" }));
  });
});
