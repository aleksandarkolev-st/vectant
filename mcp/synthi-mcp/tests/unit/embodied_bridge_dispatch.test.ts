import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  embodiedBridgeContext,
  dispatchEmbodied,
  EMBODIED_TOOL_NAMES,
} from "../../src/browser_workflow_bridge/embodied_dispatch.js";
import { unregisterAllSubstrateAdapters } from "../../src/embodied/substrate.js";

describe("workflow bridge serves the substrate-neutral embodied tools", () => {
  it("exposes all ten tools under their synthi_* names", () => {
    expect(EMBODIED_TOOL_NAMES).toEqual([
      "synthi_attach_substrate",
      "synthi_observe",
      "synthi_begin_teach",
      "synthi_end_teach",
      "synthi_compile_workflow",
      "synthi_run_workflow",
      "synthi_explain_failure",
      "synthi_export_skill",
      "synthi_import_skill",
      "synthi_list_skills",
    ]);
  });

  it("attach with no arguments lists registered substrates (the picker feed)", async () => {
    unregisterAllSubstrateAdapters();
    embodiedBridgeContext(); // bootstraps terminal + runtime adapters
    const response = (await dispatchEmbodied("synthi_attach_substrate", {}))!;
    expect(response).not.toBeNull();
    const payload = response.structuredContent as { available_substrates: string[] };
    // The picker shows exactly these names - zero jargon, working default.
    expect(payload.available_substrates).toContain("terminal");
    expect(payload.available_substrates).toContain("runtime");
  });

  it("persists a session across bridge calls: attach -> observe -> teach", async () => {
    unregisterAllSubstrateAdapters();
    const root = mkdtempSync(join(tmpdir(), "bridge-"));
    try {
      embodiedBridgeContext();

      const attached = await dispatchEmbodied("synthi_attach_substrate", {
        substrate_kind: "terminal",
        consent: {
          subject: "user",
          realm: { realm_kind: "workspace", realm_id: root },
          allow: ["observe", "record", "act"],
        },
      });
      const session = (attached!.structuredContent as { session_id: string }).session_id;
      expect(session).toBeTruthy();

      const observed = await dispatchEmbodied("synthi_observe", { session_id: session });
      expect((observed!.structuredContent as { observation: { cwd: string } }).observation.cwd).toBe(root);

      await dispatchEmbodied("synthi_begin_teach", { session_id: session });
      const recording = await dispatchEmbodied("synthi_observe", { session_id: session });
      expect(recording!.structuredContent!.ok).toBe(true); // session still alive
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null for non-embodied tools so other dispatchers handle them", async () => {
    expect(await dispatchEmbodied("synthi_browser_snapshot", {})).toBeNull();
    expect(await dispatchEmbodied("unknown_tool", {})).toBeNull();
  });
});
