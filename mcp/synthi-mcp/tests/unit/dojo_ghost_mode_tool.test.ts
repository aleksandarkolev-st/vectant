import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserBroker } from "../../src/browser/broker.js";
import { dojoSkillRegistry } from "../../src/browser/dojo.js";
import { InMemoryDojoSkillStore } from "../../src/browser/dojo_store.js";
import { InMemoryPrivateWorkflowToolStore, privateWorkflowToolRegistry } from "../../src/browser/private_tool_registry.js";
import { sourceIdentityRegistry } from "../../src/browser/source_identity.js";
import { dispatchDojoTool } from "../../src/tools/dojo.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv };
  browserBroker.resetForTests();
  sourceIdentityRegistry.resetForTests();
  privateWorkflowToolRegistry.useStoreForTests(new InMemoryPrivateWorkflowToolStore());
  privateWorkflowToolRegistry.resetForTests();
  dojoSkillRegistry.useStoreForTests(new InMemoryDojoSkillStore());
  dojoSkillRegistry.resetForTests();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Dojo Ghost Mode tool", () => {
  it("records non-mutating shadow evidence, audit custody, mismatch entrustment block, and compliance-pack visibility", async () => {
    recordOpenDetailsWorkflow();
    const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
      workspace_id: "workspace-a",
      reason: "ghost_mode_unit_publish",
      actor_id: "ghost-mode-publisher",
      actor_type: "human",
      evidence_refs: ["evidence:ghost-mode-publish"],
    });
    expect(publish?.isError).toBeUndefined();
    const published = publish?.structuredContent as { skill: { skill_id: string; workflow_id: string } };

    const ghostMode = await dispatchDojoTool("synthi_dojo_run_ghost_mode", {
      skill_id: published.skill.skill_id,
      observed_human_action: { label: "Open details", action: "click" },
      agent_planned_action: { label: "Delete details", action: "click" },
      now: "2026-06-11T00:02:00.000Z",
    });

    expect(ghostMode?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "executable",
      ghost_run: expect.objectContaining({
        mode: "ghost",
        status: "mismatch",
        would_execute: false,
        production_mutations_executed: false,
        shadow_evidence_id: expect.stringMatching(/^ghost_evidence_/),
        shadow_evidence_audit_event_id: expect.stringMatching(/^audit_/),
        evidence_refs: expect.arrayContaining([
          `skill:${published.skill.skill_id}`,
          expect.stringMatching(/^ghost:ghost_/),
        ]),
        entrustment_impact: expect.objectContaining({
          upgrade_allowed: false,
          recommended_entrustment: "EX",
        }),
      }),
      shadow_evidence: expect.objectContaining({
        schema_version: "synthi.dojo.ghostShadowEvidence.v1",
        production_mutations_executed: false,
        action_matches: false,
        observed_label: "open details",
        planned_label: "delete details",
        entrustment_impact: expect.objectContaining({
          reason: expect.stringContaining("prevents entrustment upgrade"),
        }),
      }),
      shadow_evidence_recorded: true,
      shadow_evidence_audit_event: expect.objectContaining({
        audit_event_id: expect.stringMatching(/^audit_/),
        event_type: "ghost_shadow_evidence_recorded",
        entity_kind: "ghost_shadow_evidence",
        entity_id: expect.stringMatching(/^ghost_evidence_/),
        details: expect.objectContaining({
          skill_id: published.skill.skill_id,
          workflow_id: published.skill.workflow_id,
          action_matches: false,
          production_mutations_executed: false,
          recommended_entrustment: "EX",
        }),
      }),
    }));

    const shadowEvidence = (ghostMode?.structuredContent as { shadow_evidence: { evidence_id: string } }).shadow_evidence;
    const auditEvent = (ghostMode?.structuredContent as { shadow_evidence_audit_event: { audit_event_id: string } }).shadow_evidence_audit_event;
    expect(dojoSkillRegistry.listGhostShadowEvidence({ evidence_id: shadowEvidence.evidence_id })).toEqual([
      expect.objectContaining({
        evidence_id: shadowEvidence.evidence_id,
        skill_id: published.skill.skill_id,
        workflow_id: published.skill.workflow_id,
        production_mutations_executed: false,
        action_matches: false,
      }),
    ]);
    expect(dojoSkillRegistry.listAuditEvents({
      event_type: "ghost_shadow_evidence_recorded",
      entity_kind: "ghost_shadow_evidence",
      entity_id: shadowEvidence.evidence_id,
    })).toEqual([
      expect.objectContaining({
        audit_event_id: auditEvent.audit_event_id,
        details: expect.objectContaining({
          skill_id: published.skill.skill_id,
          run_id: expect.stringMatching(/^ghost_/),
          production_mutations_executed: false,
        }),
      }),
    ]);

    const compliance = await dispatchDojoTool("synthi_dojo_export_compliance_pack", {
      skill_id: published.skill.skill_id,
      now: "2026-06-11T00:02:30.000Z",
    });
    expect(compliance?.structuredContent).toEqual(expect.objectContaining({
      pack: expect.objectContaining({
        audit_exports: expect.arrayContaining([
          expect.objectContaining({
            export_id: "control_plane_audit",
            status: "available",
            audit_event_refs: expect.arrayContaining([`audit:${auditEvent.audit_event_id}`]),
            event_type_counts: expect.objectContaining({
              ghost_shadow_evidence_recorded: 1,
            }),
          }),
        ]),
        compliance_evidence_pack: expect.objectContaining({
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              artifact_id: "control_plane_audit",
              status: "available",
              evidence_refs: expect.arrayContaining([`audit:${auditEvent.audit_event_id}`]),
            }),
          ]),
        }),
      }),
    }));
  });
});

function recordOpenDetailsWorkflow(): void {
  const url = "https://app.example.test/settings";
  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
  browserBroker.selectTab("tab-a");
  expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
  registerSourceToken("details.open");
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { role: "button", name: "Open details", source_id: "details.open" },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"button\", { name: \"Open details\" })", confidence: 0.98, reason: "role" },
    ],
  });
}

function registerSourceToken(token: string): void {
  const filePath = `src/${token}.tsx`;
  sourceIdentityRegistry.register({
    workspaceId: "workspace-a",
    filePath,
    adapter: "unit-test",
    transformVersion: "unit_source_identity_v1",
    tokens: [{ token, file: filePath, tag: "button", line: 1, column: 1 }],
  });
}
