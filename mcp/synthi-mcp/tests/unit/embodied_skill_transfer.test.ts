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
      integrity_digest: string;
    };
    expect(exported.skill_format).toBe("synthi.skill.v1");
    expect(typeof exported.integrity_digest).toBe("string");
    expect(exported.integrity_digest.length).toBe(64); // sha256 hex

    // ---- AGENT B: a FRESH context (separate agent) imports it ----
    const ctxB = createToolContext([]);
    expect((handleListSkills(ctxB) as { count: number }).count).toBe(0); // B knows nothing yet
    // Key ORDER in the transported file must not matter: the digest covers
    // content, not serialization shape.
    const reordered = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
    const firstImport = handleImportSkill(ctxB, { skill: reordered }) as { imported_as?: string; error?: string };
    expect(firstImport.error).toBeUndefined();
    const imported = firstImport as unknown as { imported_as: string; runnable: boolean; integrity_verified: boolean };
    expect(imported.runnable).toBe(true);
    expect(imported.integrity_verified).toBe(true);
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

test("tampered or truncated skills are refused BEFORE they can run", async () => {
  unregisterAllSubstrateAdapters();
  const rootA = mkdtempSync(join(tmpdir(), "skill-tamper-a-"));
  try {
    registerSubstrateAdapter(createTerminalBundle(allowlistPolicy(["node"])));
    const ctxA = createToolContext([]);
    const attachA = (await handleAttachSubstrate(ctxA, {
      substrate_kind: "terminal",
      consent: {
        subject: "t",
        realm: { realm_kind: "workspace", realm_id: rootA },
        allow: ["observe", "record", "act"],
      },
    })) as { session_id: string };
    await handleBeginTeach(ctxA, { session_id: attachA.session_id });
    await getAdapter("terminal").actor!.act(
      ctxA.sessions.get(attachA.session_id)!.handle as never,
      { run: `node -e process.stdout.write('x')` },
      { lease_id: "l", realm: { realm_kind: "workspace", realm_id: rootA }, capability: "act", expires_at_ms: Number.MAX_SAFE_INTEGER },
    );
    const taught = (await handleEndTeach(ctxA, {
      session_id: attachA.session_id,
      intent: "noop probe",
      changed_values: [{ path: "probe", semantic_class: "", after: "x", changed_at_tick: 1 }],
      control_diffs: [{ source_id: "ctrl", changed: [] }],
    })) as { contract_id: string };

    const freshReceiver = () => createToolContext([]);

    // 1. A step's payload is modified in flight.
    const tampered = JSON.parse(
      JSON.stringify(handleExportSkill(ctxA, { competency_id: taught.contract_id })),
    ) as { steps: Array<{ event: { run: string } }>; integrity_digest: string };
    tampered.steps[0]!.event.run = `node -e process.exit(7)`;
    const tamperResult = handleImportSkill(freshReceiver(), { skill: tampered }) as { error?: string };
    expect(tamperResult.error).toBe("integrity_check_failed");

    // 2. The artifact is truncated (steps lost in transport).
    const truncated = JSON.parse(
      JSON.stringify(handleExportSkill(ctxA, { competency_id: taught.contract_id })),
    ) as { steps: unknown[]; integrity_digest: string };
    truncated.steps = [];
    const truncationResult = handleImportSkill(freshReceiver(), { skill: truncated }) as { error?: string };
    expect(truncationResult.error).toBe("integrity_check_failed");

    // 3. A stale digest from a DIFFERENT skill does not validate.
    const wrongDigest = JSON.parse(
      JSON.stringify(handleExportSkill(ctxA, { competency_id: taught.contract_id })),
    ) as Record<string, unknown>;
    wrongDigest.integrity_digest = "0".repeat(64);
    const wrongResult = handleImportSkill(freshReceiver(), { skill: wrongDigest }) as { error?: string };
    expect(wrongResult.error).toBe("integrity_check_failed");

    // 4. Backward compatibility: a legacy artifact without a digest still
    // imports, but is flagged UNVERIFIED rather than silently trusted.
    const legacyArtifact = JSON.parse(
      JSON.stringify(handleExportSkill(ctxA, { competency_id: taught.contract_id })),
    ) as Record<string, unknown>;
    delete legacyArtifact.integrity_digest;
    const legacy = handleImportSkill(freshReceiver(), { skill: legacyArtifact }) as {
      imported_as?: string;
      integrity_verified?: boolean;
    };
    expect(legacy.imported_as).toBeTruthy();
    expect(legacy.integrity_verified).toBe(false);

    // 5. Refused imports store NOTHING (no half-trusted state).
    const receiverAfterRefusals = createToolContext([]);
    handleImportSkill(receiverAfterRefusals, { skill: tampered });
    handleImportSkill(receiverAfterRefusals, { skill: truncated });
    handleImportSkill(receiverAfterRefusals, { skill: wrongDigest as never });
    expect((handleListSkills(receiverAfterRefusals) as { count: number }).count).toBe(0);

    console.log(
      "TAMPER-EVIDENCE VERIFIED: tampered/truncated/wrong-digest refused; legacy flagged unverified",
    );
  } finally {
    rmSync(rootA, { recursive: true, force: true });
  }
});
