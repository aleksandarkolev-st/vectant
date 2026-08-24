/**
 * Agent-to-agent skill transfer (LIVE): agent A teaches a workflow on a
 * real project, exports it as synthi.skill.v1; agent B (a completely
 * separate ToolContext = separate brain) imports it and RUNS it against
 * a different project, verifying effects on disk.
 */
import { test, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolContext,
  handleAttachSubstrate,
  handleBeginTeach,
  handleEndTeach,
  handleExportSkill,
  handleImportSkill,
  handleListSkills,
  handleRunWorkflow,
} from "../../src/embodied/tools.js";
import { registerSubstrateAdapter, unregisterAllSubstrateAdapters, getAdapter } from "../../src/embodied/substrate.js";
import { createTerminalBundle, allowlistPolicy } from "../../src/embodied/adapters/terminal/index.js";
import type { CompetencyLicense } from "../../src/embodied/governance.js";

test("agent A teaches -> exports -> agent B imports and executes", async () => {
  unregisterAllSubstrateAdapters();
  const rootA = mkdtempSync(join(tmpdir(), "skill-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "skill-b-"));
  try {
    registerSubstrateAdapter(createTerminalBundle(allowlistPolicy(["node"])));
    const consent = (root: string) => ({
      subject: "t",
      realm: { realm_kind: "workspace", realm_id: root },
      allow: ["observe", "record", "act"],
    });

    // ---- AGENT A: teach the scaffold flow on its own project ----
    const ctxA = createToolContext([]);
    const attachA = (await handleAttachSubstrate(ctxA, {
      substrate_kind: "terminal",
      consent: consent(rootA),
    })) as { session_id: string };
    await handleBeginTeach(ctxA, { session_id: attachA.session_id });
    await getAdapter("terminal").actor!.act(
      ctxA.sessions.get(attachA.session_id)!.handle as never,
      { run: `node -e require('fs').mkdirSync('synthi',{recursive:true})` },
      { lease_id: "l", realm: { realm_kind: "workspace", realm_id: rootA }, capability: "act", expires_at_ms: Number.MAX_SAFE_INTEGER },
    );
    await getAdapter("terminal").actor!.act(
      ctxA.sessions.get(attachA.session_id)!.handle as never,
      { run: `node -e require('fs').writeFileSync('synthi/config.json','{"agent":"A"}')` },
      { lease_id: "l", realm: { realm_kind: "workspace", realm_id: rootA }, capability: "act", expires_at_ms: Number.MAX_SAFE_INTEGER },
    );
    const taught = (await handleEndTeach(ctxA, {
      session_id: attachA.session_id,
      intent: "scaffold synthi config",
      changed_values: [
        { path: "synthi", semantic_class: "", after: "<dir>", changed_at_tick: 1 },
        { path: "synthi/config.json", semantic_class: "", after: '{"agent":"A"}', changed_at_tick: 2 },
      ],
      control_diffs: [{ source_id: "ctrl", changed: [] }],
    })) as { contract_id: string };

    // ---- EXPORT: A hands the skill file to B ----
    const exported = handleExportSkill(ctxA, { competency_id: taught.contract_id }) as {
      skill_format: string;
      contract: unknown;
      substrate_kind: string;
    };
    expect(exported.skill_format).toBe("synthi.skill.v1");

    // ---- AGENT B: a FRESH context (separate agent) imports it ----
    const ctxB = createToolContext([]);
    expect((handleListSkills(ctxB) as { count: number }).count).toBe(0); // B knows nothing yet
    const imported = handleImportSkill(ctxB, { skill: exported }) as { imported_as: string };
    expect(imported.runnable).toBe(true);
    expect((handleListSkills(ctxB) as { count: number }).count).toBe(1);

    // B attaches to ITS OWN project (never seen by A) and runs the skill.
    const attachB = (await handleAttachSubstrate(ctxB, {
      substrate_kind: "terminal",
      consent: consent(rootB),
    })) as { session_id: string };
    (ctxB.licenses as CompetencyLicense[]).push({
      license_id: "lic-b",
      competency_id: imported.imported_as,
      substrate_scope: ["terminal"],
      realm_scopes: [{ realm_kind: "workspace", realm_id: rootB }],
      entrustment: "E2_supervised",
      issued_at_ms: 0,
      expires_at_ms: Number.MAX_SAFE_INTEGER,
    });
    ctxB.now = Date.now();
    const run = (await handleRunWorkflow(ctxB, {
      competency_id: imported.imported_as,
      session_id: attachB.session_id,
      mode: "fresh_state",
      required_level: "E2_supervised",
    })) as { ok: boolean; step_results: Array<{ ok: boolean }> };
    expect(run.ok).toBe(true);

    // Effects verified ON DISK in B's own project.
    expect(existsSync(join(rootB, "synthi", "config.json"))).toBe(true);
    expect(readFileSync(join(rootB, "synthi", "config.json"), "utf8")).toBe('{"agent":"A"}');
    console.log("AGENT-TO-AGENT TRANSFER VERIFIED: A taught, B executed on an unseen project");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});
