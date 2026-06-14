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

describe("Dojo Skill Passport and consumer Skill Card contract", () => {
  it("returns a report-only passport with license, readiness, proof, coverage, attack, published-tool scope, and executable entrustment provenance", async () => {
    const { skill, toolName } = await publishApproverWorkflowSkill();

    const passport = await dispatchDojoTool("synthi_dojo_get_skill_passport", {
      skill_id: skill.skill_id,
    });

    expect(passport?.isError).toBeUndefined();
    expect(passport?.structuredContent).toEqual(expect.objectContaining({
      implementation_status: "report_only",
      runtime_enforced: false,
      skill_id: skill.skill_id,
      entrustment_source: "executable_checkride",
      executable_entrustment: expect.objectContaining({
        schema_version: "synthi.dojo.executableEntrustmentSnapshot.v1",
        source: "publish",
        checkride_id: skill.executable_entrustment?.checkride_id,
        scenario_count: skill.executable_entrustment?.scenario_count,
        entrustment_decision: expect.objectContaining({
          level: skill.permission_license.entrustment_level,
        }),
        readiness_decision: expect.objectContaining({
          level: skill.skill_readiness_level,
        }),
      }),
      license_scope: expect.objectContaining({
        allowed_actions: skill.permission_license.allowed_actions,
        gated_actions: skill.permission_license.gated_actions,
        blocked_actions: skill.permission_license.blocked_actions,
      }),
      evidence_refs: skill.executable_entrustment?.evidence_refs,
      skill_passport: expect.objectContaining({
        passport_id: expect.stringMatching(/^passport_/),
        skill_id: skill.skill_id,
        skill_version: skill.skill_version,
        entrustment_level: skill.permission_license.entrustment_level,
        readiness_level: skill.skill_readiness_level,
        checkride_id: skill.checkride.checkride_id,
        license_id: skill.permission_license.license_id,
        assurance_case_id: skill.assurance_case.assurance_case_id,
        proof_required: skill.permission_license.proof_requirements.required_evidence_claims.length > 0,
        coverage_score: skill.coverage_score,
        attack_success_rate: skill.attack_success_rate,
        license_expires_at: skill.license_expires_at,
        published_tools: expect.arrayContaining([toolName]),
        issued_at: expect.any(String),
      }),
    }));
    expect(skill.executable_entrustment?.evidence_refs.length).toBeGreaterThan(0);
  });

  it("keeps the consumer skill card aligned with allowed, ask-before, blocked, proof badge, practice, and guardrail counts", async () => {
    const { skill } = await publishApproverWorkflowSkill();

    const details = await dispatchDojoTool("synthi_dojo_get_skill", {
      skill_id: skill.skill_id,
    });

    const card = skill.skill_card;
    expect(details?.isError).toBeUndefined();
    expect(details?.structuredContent).toEqual(expect.objectContaining({
      skill: expect.objectContaining({
        skill_card: card,
      }),
    }));
    expect(card).toEqual(expect.objectContaining({
      title: skill.name,
      status: `Licensed ${skill.permission_license.entrustment_level}`,
      can_do_alone: skill.permission_license.allowed_actions.map((action) => action.action),
      will_ask_before: skill.permission_license.gated_actions.map((action) => action.action),
      will_not_do: skill.permission_license.blocked_actions.map((action) => action.action),
      practiced: `${skill.checkride.results.length} synthetic cases`,
      found_and_fixed: `${skill.guardrails.length} guardrails`,
      proof_badge: skill.skill_passport.proof_required ? "Proof required" : "Proof optional",
    }));
  });

  it("exports the Skill Passport artifact and keeps the consumer export summary free of raw production payloads", async () => {
    const { skill, repoArtifacts } = await publishApproverWorkflowSkill();

    const passportArtifact = repoArtifacts.find((artifact) => artifact.path.endsWith("/skill-passport.json"));

    expect(passportArtifact).toEqual(expect.objectContaining({
      path: expect.stringContaining(`/${skill.skill_id.replace(/^dojo_/, "")}/skill-passport.json`),
      content_type: "application/json",
      sensitive: false,
    }));
    expect(JSON.stringify(passportArtifact)).not.toMatch(/cookie|authorization|bearer|password|secret/i);
  });
});

async function publishApproverWorkflowSkill(): Promise<{
  skill: NonNullable<ReturnType<typeof dojoSkillRegistry.get>>;
  toolName: string;
  repoArtifacts: Array<{ path: string; content_type: string; sensitive: boolean }>;
}> {
  recordApproverWorkflow();
  const publish = await dispatchDojoTool("synthi_dojo_publish_skill", {
    workspace_id: "workspace-a",
    reason: "skill_passport_unit_publish",
    actor_id: "passport-publisher",
    actor_type: "human",
    evidence_refs: ["evidence:skill-passport-publish"],
  });
  expect(publish?.isError).toBeUndefined();
  const content = publish?.structuredContent as {
    skill: { skill_id: string };
    tool_name: string;
    repo_artifacts: Array<{ path: string; content_type: string; sensitive: boolean }>;
  };
  const skill = dojoSkillRegistry.get(content.skill.skill_id);
  expect(skill).toBeTruthy();
  return {
    skill: skill!,
    toolName: content.tool_name,
    repoArtifacts: content.repo_artifacts,
  };
}

function recordApproverWorkflow(): void {
  const url = "https://app.example.test/approvals";
  browserBroker.requestConsent(url);
  browserBroker.registerTabs([{ tab_id: "tab-approvals", url, active: true }]);
  browserBroker.selectTab("tab-approvals");
  expect(browserBroker.startTeachMode("tab-approvals").ok).toBe(true);
  registerSourceToken("approval.amount");
  registerSourceToken("approval.submit");
  browserBroker.recordHumanAction({
    tab_id: "tab-approvals",
    url,
    origin: "https://app.example.test",
    action: "input",
    value: "125.00",
    element: { role: "spinbutton", name: "Amount", source_id: "approval.amount" },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"spinbutton\", { name: \"Amount\" })", confidence: 0.96, reason: "role" },
    ],
  });
  browserBroker.recordHumanAction({
    tab_id: "tab-approvals",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { role: "button", name: "Submit approval", source_id: "approval.submit" },
    locator_candidates: [
      { kind: "role", locator: "page.getByRole(\"button\", { name: \"Submit approval\" })", confidence: 0.98, reason: "role" },
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
