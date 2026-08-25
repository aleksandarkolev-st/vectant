import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolContext,
  handleAttachSubstrate,
  handleObserve,
  handleBeginTeach,
  handleEndTeach,
  handleCompileWorkflow,
  handleRunWorkflow,
  handleExplainFailure,
  type ToolContext,
} from "../../src/embodied/tools.js";
import { registerSubstrateAdapter, unregisterAllSubstrateAdapters } from "../../src/embodied/substrate.js";
import { createTerminalBundle, allowlistPolicy } from "../../src/browser/../embodied/adapters/terminal/index.js";
import type { CompetencyLicense } from "../../src/embodied/governance.js";

async function setup(): Promise<{ context: ToolContext; sessionId: string; root: string }> {
  unregisterAllSubstrateAdapters();
  const root = mkdtempSync(join(tmpdir(), "tools-"));
  registerSubstrateAdapter(createTerminalBundle(allowlistPolicy(["node"])));
  const context = createToolContext([]);
  const attached = (await handleAttachSubstrate(context, {
    substrate_kind: "terminal",
    consent: {
      subject: "user",
      realm: { realm_kind: "workspace", realm_id: root },
      allow: ["observe", "record", "act"],
    },
  })) as { session_id: string };
  return { context, sessionId: attached.session_id, root };
}

describe("substrate-neutral MCP tool surface", () => {
  it("lists registered substrates when called without arguments", async () => {
    const { context } = await setup();
    const listing = handleAttachSubstrate(context, {}) as { available_substrates: string[] };
    expect(listing.available_substrates).toContain("terminal");
  });

  it("walks attach -> observe -> teach -> compile -> licensed run -> refusal -> explain", async () => {
    const { context, sessionId, root } = await setup();

    const observed = (await handleObserve(context, { session_id: sessionId })) as {
      observation: { cwd: string };
    };
    expect(observed.observation.cwd).toBe(root);

    await handleBeginTeach(context, { session_id: sessionId });
    // The human hand performs one real command during recording: drive the
    // registered adapter's actor directly with the session's handle.
    const session = context.sessions.get(sessionId)!;
    const { getAdapter } = await import("../../src/embodied/substrate.js");
    const adapter = getAdapter("terminal");
    const actResult = await adapter.actor!.act(
      session.handle as never,
      { run: `node -e require('fs').writeFileSync('taught.txt','1')` },
      { lease_id: "l", realm: { realm_kind: "workspace", realm_id: root }, capability: "act", expires_at_ms: Number.MAX_SAFE_INTEGER },
    );
    expect(actResult.ok).toBe(true);

    // Stage 1 belongs to the client: observe the effect and pass the diff.
    const taught = (await handleEndTeach(context, {
      session_id: sessionId,
      intent: "write a file",
      changed_values: [{ path: "taught.txt", semantic_class: "", before: undefined, after: "1", changed_at_tick: 1 }],
      control_diffs: [{ source_id: "ctrl", changed: [] }],
    })) as {
      steps_recorded: number;
      contract_id: string | null;
    };
    expect(taught.steps_recorded).toBe(1);
    expect(taught.contract_id).not.toBeNull();

    const compiled = handleCompileWorkflow(context, { competency_id: taught.contract_id! }) as {
      contract: { contract_id: string };
    };
    expect(compiled.contract.contract_id).toBe(taught.contract_id);

    // Without a license: refused with a human reason, no execution.
    const unlicensed = (await handleRunWorkflow(context, {
      competency_id: taught.contract_id!,
      session_id: sessionId,
      mode: "fresh_state",
    })) as { ok: boolean; refusal_reason?: string };
    expect(unlicensed.ok).toBe(false);
    expect(unlicensed.refusal_reason).toBeTruthy();

    // Grant a license and re-run.
    const licensedContext = context;
    (licensedContext.licenses as CompetencyLicense[]).push({
      license_id: "lic-t",
      competency_id: taught.contract_id!,
      substrate_scope: ["terminal"],
      realm_scopes: [{ realm_kind: "workspace", realm_id: root }],
      entrustment: "E2_supervised",
      issued_at_ms: 0,
      expires_at_ms: Number.MAX_SAFE_INTEGER,
    });
    licensedContext.now = Date.now();
    const run = (await handleRunWorkflow(context, {
      competency_id: taught.contract_id!,
      session_id: sessionId,
      mode: "fresh_state",
      required_level: "E2_supervised",
    })) as { ok: boolean; step_results: Array<{ ok: boolean }> };
    expect(run.ok).toBe(true);
    expect(run.step_results.every((s) => s.ok)).toBe(true);

    // Verb 5 works standalone.
    const explained = handleExplainFailure(context, { step_index: 0, classifier_trunk: "identity_lost" }) as {
      explanation: string;
    };
    expect(explained.explanation).toMatch(/^Step 1 failed: /);

    rmSync(root, { recursive: true, force: true });
  });
});
