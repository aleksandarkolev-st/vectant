/**
 * Plan P4 golden fixture: edit-HMR-verify.
 *
 * The plan's cross-substrate acceptance: edit a file (terminal world),
 * record the change as a fact (kv world), and verify - a multi-substrate
 * workflow graph with per-node authorization, taught end to end.
 * Composes with runCrossSubstrateWorkflow and the licensing layer.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalBundle, allowlistPolicy } from "../../src/embodied/adapters/terminal/index.js";
import { createApiBundle, emitTool, type ApiSessionState } from "../../src/embodied/adapters/api/index.js";
import { authorizeRun, type CompetencyLicense } from "../../src/embodied/governance.js";

describe("P4 golden fixture: edit-HMR-verify", () => {
  it("edit propagates through capture to an emitted tool, licensed per node", async () => {
    const root = mkdtempSync(join(tmpdir(), "gold-hmr-"));
    try {
      const termBundle = createTerminalBundle(allowlistPolicy(["node"]));
      const termHandle = await termBundle.attach({
        realm: { realm_kind: "workspace", realm_id: root },
        consent_proof: { subject: "t", realm: { realm_kind: "workspace", realm_id: root }, approved_capabilities: ["observe", "record", "act"] },
      });

      // 1. Edit: write the feature flag file for real.
      await termBundle.actor!.act(
        termHandle,
        { run: `node -e require('fs').writeFileSync('feature.flag','hmr-on')` },
        {
          lease_id: "l",
          realm: { realm_kind: "workspace", realm_id: root },
          capability: "act",
          expires_at_ms: Number.MAX_SAFE_INTEGER,
        },
      );
      expect(existsSync(join(root, "feature.flag"))).toBe(true);

      // 2. Capture the deployment API call that would follow the HMR reload.
      const apiBundle = createApiBundle();
      const apiHandle = await apiBundle.attach({
        realm: { realm_kind: "origin", realm_id: "https://deploy.internal" },
        consent_proof: { subject: "t", realm: { realm_kind: "origin", realm_id: "https://deploy.internal" }, approved_capabilities: ["record", "act"] },
      });
      apiBundle.recorder!.beginRecord(apiHandle);
      await apiBundle.actor!.act(
        apiHandle,
        { method: "POST", path: "/v1/reload", body: { flag: "hmr-on", graceful: true }, headers: { Authorization: "Bearer real-token" } },
        {
          lease_id: "l",
          realm: { realm_kind: "origin", realm_id: "https://deploy.internal" },
          capability: "act",
          expires_at_ms: Number.MAX_SAFE_INTEGER,
        },
      );
      const fragment = apiBundle.recorder!.endRecord(apiHandle);

      // 3. Compile the captured flow into an emitted tool.
      const session: ApiSessionState = {
        base_url: "https://deploy.internal",
        captured: fragment.steps.map((step) => {
          const event = step.event as { method: string; path: string; body?: unknown; headers?: Record<string, string> };
          const { Authorization } = event.headers ?? {};
          void Authorization;
          return { request: event, response: { status: 200 } };
        }),
      };
      const tool = emitTool(session, "trigger_reload");
      expect(tool.input_schema.required).toContain("flag");
      // The scrubbed recipe must not carry the credential.
      expect(JSON.stringify(tool.recipe)).not.toContain("real-token");

      // 4. Per-node licensing: the workflow is authorized only where scoped.
      const licenses: CompetencyLicense[] = [
        {
          license_id: "lic-hmr",
          competency_id: "comp.hmr",
          substrate_scope: ["terminal"], // terminal only - API node unlicensed
          realm_scopes: [{ realm_kind: "workspace", realm_id: root }],
          entrustment: "E2_supervised",
          issued_at_ms: 0,
          expires_at_ms: Number.MAX_SAFE_INTEGER,
        },
      ];
      const editDecision = authorizeRun(licenses, {
        competency_id: "comp.hmr",
        substrate_kind: "terminal",
        realm: { realm_kind: "workspace", realm_id: root },
        required_level: "E2_supervised",
        now: 100,
      });
      expect(editDecision.authorized).toBe(true);
      const reloadDecision = authorizeRun(licenses, {
        competency_id: "comp.hmr",
        substrate_kind: "api",
        realm: { realm_kind: "origin", realm_id: "https://deploy.internal" },
        required_level: "E2_supervised",
        now: 100,
      });
      expect(reloadDecision.authorized).toBe(false); // api scope not granted
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
