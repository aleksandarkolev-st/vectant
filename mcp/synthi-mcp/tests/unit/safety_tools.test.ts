import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authCheckpointManager, type AuthBrowserStorageState } from "../../src/browser/auth.js";
import { browserBroker } from "../../src/browser/broker.js";
import { replayIsolationProfiles } from "../../src/browser/safety.js";
import { eventLog } from "../../src/events/index.js";
import { ADVERTISED_TOOLS } from "../../src/tool_registry.js";
import { SAFETY_TOOL_NAMES, SAFETY_TOOLS, dispatchSafetyTool } from "../../src/tools/safety.js";

const originalCiMarkerPath = process.env["CI_MARKER_PATH"];
const originalExpectedCiCwd = process.env["EXPECTED_CI_CWD"];
const originalWorkflowCiArtifactDir = process.env["SYNTHI_WORKFLOW_CI_ARTIFACT_DIR"];

beforeEach(() => {
  browserBroker.resetForTests();
  authCheckpointManager.resetForTests();
  replayIsolationProfiles.resetForTests();
  eventLog._resetForTests();
});

afterEach(() => {
  if (originalCiMarkerPath === undefined) {
    delete process.env["CI_MARKER_PATH"];
  } else {
    process.env["CI_MARKER_PATH"] = originalCiMarkerPath;
  }
  if (originalExpectedCiCwd === undefined) {
    delete process.env["EXPECTED_CI_CWD"];
  } else {
    process.env["EXPECTED_CI_CWD"] = originalExpectedCiCwd;
  }
  if (originalWorkflowCiArtifactDir === undefined) {
    delete process.env["SYNTHI_WORKFLOW_CI_ARTIFACT_DIR"];
  } else {
    process.env["SYNTHI_WORKFLOW_CI_ARTIFACT_DIR"] = originalWorkflowCiArtifactDir;
  }
});

function visualProofScriptLines(): string[] {
  return [
    "if (!process.env.SYNTHI_WORKFLOW_VISUAL_PROOF_DIR) throw new Error('visual_proof_dir_missing');",
    "await writeFile(`${process.env.SYNTHI_WORKFLOW_VISUAL_PROOF_DIR}/page-1.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));",
  ];
}

describe("safety MCP tool surface", () => {
  it("advertises every safety tool in the capability registry", () => {
    for (const name of SAFETY_TOOL_NAMES) {
      expect(ADVERTISED_TOOLS).toContain(name);
      expect(SAFETY_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
  });

  it("returns null for non-safety tool dispatch", async () => {
    expect(await dispatchSafetyTool("synthi_health", {})).toBeNull();
  });

  it("exposes mutation boundaries and read-only prefix validation", async () => {
    teachSaveWorkflow();

    const mutationPlan = await dispatchSafetyTool("synthi_safety_get_mutation_plan", { workspace_id: "workspace-a" });
    expect(mutationPlan?.isError).toBeUndefined();
    expect((mutationPlan?.structuredContent as {
      mutation_plan: {
        has_mutation: boolean;
        first_mutation_step_id: string;
        background_hardening: { allowed: boolean; mode: string };
        ci_full_replay: { configured: boolean; blockers: string[] };
      };
    }).mutation_plan).toEqual(expect.objectContaining({
      has_mutation: true,
      first_mutation_step_id: "browser_evt_2",
      background_hardening: expect.objectContaining({ allowed: false, mode: "blocked" }),
      ci_full_replay: expect.objectContaining({
        configured: false,
        blockers: expect.arrayContaining(["ci_isolation_profile_not_ready", "mutation_replay_not_explicitly_allowed"]),
      }),
    }));

    const prefix = await dispatchSafetyTool("synthi_safety_run_prefix_validation", {});
    expect(prefix?.isError).toBeUndefined();
    expect(prefix?.structuredContent).toEqual(expect.objectContaining({ ok: true }));
    expect((prefix?.structuredContent as {
      validation: {
        validation_type: string;
        read_only: boolean;
        mutation_executed: boolean;
        status: string;
        planned_step_count: number;
        stopped_before_step_id: string;
      };
    }).validation).toEqual(expect.objectContaining({
      validation_type: "dryRunPlan",
      read_only: true,
      mutation_executed: false,
      status: "stoppedAtMutationBoundary",
      planned_step_count: 1,
      stopped_before_step_id: "browser_evt_2",
    }));
  });

  it("gates CI full mutation replay on complete isolation metadata", async () => {
    teachSaveWorkflow();

    const incomplete = await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      ci_command: "npm run test:e2e",
    });
    expect((incomplete?.structuredContent as { isolation_profile: { readiness: string; missing: string[] } }).isolation_profile).toEqual(
      expect.objectContaining({
        readiness: "ciIsolatedIncomplete",
        missing: expect.arrayContaining([
          "data_reset_command",
          "reset_assertion_command",
          "postcondition_command",
          "reset_profile_id",
          "state_seed_id",
          "allow_mutation_replay",
        ]),
      })
    );

    const blocked = await dispatchSafetyTool("synthi_safety_explain_blocked_hardening", { workspace_id: "workspace-a" });
    expect((blocked?.structuredContent as { explanation: { blocked: boolean; failure_class: string } }).explanation).toEqual(
      expect.objectContaining({ blocked: true, failure_class: "mutationBlocked" })
    );

    const ready = await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      ci_command: "npm run test:e2e",
      data_reset_command: "npm run db:reset:test",
      reset_assertion_command: "npm run db:assert:test-seed",
      postcondition_command: "npm run test:workflow-postcondition",
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });
    expect((ready?.structuredContent as { isolation_profile: { readiness: string; can_run_full_mutation_replay: boolean } }).isolation_profile).toEqual(
      expect.objectContaining({
        readiness: "ciIsolatedReady",
        can_run_full_mutation_replay: true,
      })
    );

    const mutationPlan = await dispatchSafetyTool("synthi_safety_get_mutation_plan", { workspace_id: "workspace-a" });
    expect((mutationPlan?.structuredContent as {
      mutation_plan: { background_hardening: { allowed: boolean; mode: string }; ci_full_replay: { allowed: boolean; blockers: string[] } };
    }).mutation_plan).toEqual(expect.objectContaining({
      background_hardening: expect.objectContaining({ allowed: true, mode: "ciOnly" }),
      ci_full_replay: expect.objectContaining({ allowed: true, blockers: [] }),
    }));
  });

  it("runs reset before full mutation replay in a configured isolated profile", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const markerPath = path.join(artifactRoot, "marker.json");
    process.env["CI_MARKER_PATH"] = markerPath;
    const scriptDirectory = path.join(artifactRoot, "commands with spaces");
    await mkdir(scriptDirectory, { recursive: true });
    const resetScript = path.join(scriptDirectory, "reset command.mjs");
    const resetAssertionScript = path.join(scriptDirectory, "reset assertion command.mjs");
    const ciScript = path.join(scriptDirectory, "ci command.mjs");
    const postconditionScript = path.join(scriptDirectory, "postcondition command.mjs");
    await writeFile(resetScript, [
      "import { writeFile } from 'node:fs/promises';",
      "if (process.cwd() !== process.env.EXPECTED_CI_CWD) throw new Error('reset_wrong_cwd');",
      "await writeFile(process.env.CI_MARKER_PATH, JSON.stringify({ reset: true, baseUrl: process.env.PLAYWRIGHT_BASE_URL, resetProfileId: process.env.SYNTHI_WORKFLOW_CI_RESET_PROFILE_ID, seedId: process.env.SYNTHI_WORKFLOW_CI_STATE_SEED_ID }));",
      "",
    ].join("\n"));
    await writeFile(resetAssertionScript, [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "if (process.cwd() !== process.env.EXPECTED_CI_CWD) throw new Error('reset_assertion_wrong_cwd');",
      "const marker = JSON.parse(await readFile(process.env.CI_MARKER_PATH, 'utf8'));",
      "if (!marker.reset) throw new Error('reset_not_run');",
      "if (marker.resetProfileId !== 'settings-reset-v1') throw new Error('reset_profile_id_not_available_to_reset_assertion');",
      "if (marker.seedId !== 'settings-fixture-v1') throw new Error('seed_id_not_available_to_reset_assertion');",
      "await writeFile(process.env.CI_MARKER_PATH, JSON.stringify({ ...marker, resetAssertion: true }));",
      "",
    ].join("\n"));
    await writeFile(ciScript, [
      "import { appendFile, readFile, writeFile } from 'node:fs/promises';",
      "if (process.cwd() !== process.env.EXPECTED_CI_CWD) throw new Error('ci_wrong_cwd');",
      "const marker = JSON.parse(await readFile(process.env.CI_MARKER_PATH, 'utf8'));",
      "if (!marker.reset) throw new Error('reset_not_run');",
      "if (!marker.resetAssertion) throw new Error('reset_assertion_not_run');",
      "if (marker.baseUrl !== 'https://ci.example.test') throw new Error('base_url_not_available_to_reset');",
      "if (process.env.PLAYWRIGHT_BASE_URL !== 'https://ci.example.test') throw new Error('base_url_not_available_to_ci');",
      "if (process.env.SYNTHI_WORKFLOW_CI_STATE_SEED_ID !== 'settings-fixture-v1') throw new Error('seed_id_not_available_to_ci');",
      "if (process.env.SYNTHI_WORKFLOW_CI_RESET_PROFILE_ID !== 'settings-reset-v1') throw new Error('reset_profile_id_not_available_to_ci');",
      "if (!process.env.SYNTHI_WORKFLOW_CI_RUN_ID) throw new Error('run_id_missing');",
      "if (!process.env.SYNTHI_WORKFLOW_CI_NONCE) throw new Error('nonce_missing');",
      "if (process.env.ALLOW_WORKFLOW_MUTATION !== '1') throw new Error('mutation_not_allowed');",
      "if (!process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION) throw new Error('attestation_path_missing');",
      "if (process.env.EMAIL !== 'ada@example.test') throw new Error('workflow_parameter_missing');",
      "const spec = await readFile(process.env.SYNTHI_WORKFLOW_SPEC, 'utf8');",
      "if (spec.includes('Mutation boundary:')) throw new Error('prefix_only_script_generated');",
      "if (!spec.includes('await target2.click();')) throw new Error('mutation_click_not_generated');",
      "if (!spec.includes('recordWorkflowStep(\"browser_evt_2\")')) throw new Error('mutation_attestation_not_generated');",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_1', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_2', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      ...visualProofScriptLines(),
      "await writeFile(process.env.CI_MARKER_PATH, JSON.stringify({ ...marker, ci: true, workflowId: process.env.SYNTHI_WORKFLOW_ID }));",
      "",
    ].join("\n"));
    await writeFile(postconditionScript, [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "if (process.cwd() !== process.env.EXPECTED_CI_CWD) throw new Error('postcondition_wrong_cwd');",
      "const marker = JSON.parse(await readFile(process.env.CI_MARKER_PATH, 'utf8'));",
      "if (!marker.ci) throw new Error('ci_not_run');",
      "if (process.env.SYNTHI_WORKFLOW_CI_STATE_SEED_ID !== 'settings-fixture-v1') throw new Error('seed_id_not_available_to_postcondition');",
      "await writeFile(process.env.CI_MARKER_PATH, JSON.stringify({ ...marker, postcondition: true }));",
      "",
    ].join("\n"));

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    process.env["EXPECTED_CI_CWD"] = workingDirectory;
    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      parameters: { email: "ada@example.test" },
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    const body = replay?.structuredContent as {
      ok: boolean;
      replay: {
        status: string;
        mutation_executed: boolean;
        commands: { reset_exit_code: number; reset_assertion_exit_code: number; ci_exit_code: number; postcondition_exit_code: number };
        isolation_profile: { working_directory: string | null; reset_profile_id: string | null; state_seed_id: string | null };
        artifacts: { directory: string; spec_path: string; attestation_path: string; visual_proof_dir: string };
        report: { parameter_env: string[]; attested_step_ids: string[]; missing_mutation_step_ids: string[] };
      };
    };
    expect(body).toEqual(expect.objectContaining({ ok: true }));
    expect(body.replay).toEqual(expect.objectContaining({
      status: "passed",
      mutation_executed: true,
      failure_stage: null,
      isolation_profile: expect.objectContaining({
        working_directory: workingDirectory,
        reset_profile_id: "settings-reset-v1",
        state_seed_id: "settings-fixture-v1",
      }),
      commands: expect.objectContaining({
        reset_exit_code: 0,
        reset_assertion_exit_code: 0,
        ci_exit_code: 0,
        postcondition_exit_code: 0,
      }),
      report: expect.objectContaining({
        parameter_env: ["EMAIL"],
        attested_step_ids: ["browser_evt_1", "browser_evt_2"],
        missing_mutation_step_ids: [],
      }),
    }));
    const generatedSpec = await readFile(body.replay.artifacts.spec_path, "utf8");
    expect(generatedSpec).toContain("ALLOW_WORKFLOW_MUTATION");
    expect(generatedSpec).toContain("SYNTHI_WORKFLOW_REPLAY_ATTESTATION");
    expect(generatedSpec).toContain("SYNTHI_WORKFLOW_CI_RUN_ID");
    expect(generatedSpec).toContain("SYNTHI_WORKFLOW_CI_NONCE");
    expect(generatedSpec).toContain("SYNTHI_WORKFLOW_VISUAL_PROOF_DIR");
    expect(generatedSpec).toContain("captureWorkflowVisualProof");
    expect(generatedSpec).toContain("await target2.click();");
    expect(generatedSpec).not.toContain("Mutation boundary:");
    expect(body.replay.artifacts.visual_proof_dir).toContain(body.replay.artifacts.directory);
    await expect(access(path.join(body.replay.artifacts.visual_proof_dir, "page-1.png"))).resolves.toBeUndefined();
    const attestation = await readFile(body.replay.artifacts.attestation_path, "utf8");
    expect(attestation).toContain("browser_evt_2");
    expect(attestation).toContain("nonce");
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      reset?: boolean;
      resetAssertion?: boolean;
      ci?: boolean;
      postcondition?: boolean;
      workflowId?: string;
    };
    expect(marker).toEqual(expect.objectContaining({
      reset: true,
      resetAssertion: true,
      ci: true,
      postcondition: true,
      workflowId: expect.any(String),
    }));
  });

  it("does not interpret shell metacharacters in CI isolated replay commands", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-no-shell-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const resetMarkerPath = path.join(artifactRoot, "reset-ran");
    const injectedMarkerPath = path.join(artifactRoot, "shell-injection-ran");
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const injectedScript = path.join(artifactRoot, "injected.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(resetScript, [
      "import { writeFile } from 'node:fs/promises';",
      `await writeFile(${JSON.stringify(resetMarkerPath)}, 'ran');`,
      "",
    ].join("\n"));
    await writeFile(injectedScript, [
      "import { writeFile } from 'node:fs/promises';",
      `await writeFile(${JSON.stringify(injectedMarkerPath)}, 'ran');`,
      "",
    ].join("\n"));
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, [
      "import { appendFile } from 'node:fs/promises';",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_1', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_2', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      "",
    ].join("\n"));
    await writeFile(postconditionScript, "process.exit(0);\n");

    const profile = await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)} ; ${JSON.stringify(process.execPath)} ${JSON.stringify(injectedScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });
    expect((profile?.structuredContent as { isolation_profile: { readiness: string; missing: string[] } }).isolation_profile).toEqual(
      expect.objectContaining({
        readiness: "ciIsolatedIncomplete",
        missing: expect.arrayContaining(["invalid_data_reset_command"]),
      })
    );

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "blocked",
        failure_stage: "profile",
        mutation_executed: false,
        blockers: expect.arrayContaining(["ci_isolation_profile_not_ready", "invalid_data_reset_command"]),
        commands: expect.objectContaining({
          reset_exit_code: null,
          reset_assertion_exit_code: null,
          ci_exit_code: null,
          postcondition_exit_code: null,
        }),
      }),
    }));
    await expect(access(resetMarkerPath)).rejects.toThrow();
    await expect(access(injectedMarkerPath)).rejects.toThrow();
  });

  it("blocks malformed CI isolated replay command quotes before reset starts", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-bad-command-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const resetMarkerPath = path.join(artifactRoot, "reset-ran");
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(resetScript, [
      "import { writeFile } from 'node:fs/promises';",
      `await writeFile(${JSON.stringify(resetMarkerPath)}, 'ran');`,
      "",
    ].join("\n"));
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, "process.exit(0);\n");
    await writeFile(postconditionScript, "process.exit(0);\n");

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} "${resetScript}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "blocked",
        failure_stage: "profile",
        mutation_executed: false,
        blockers: expect.arrayContaining(["ci_isolation_profile_not_ready", "invalid_data_reset_command"]),
      }),
    }));
    await expect(access(resetMarkerPath)).rejects.toThrow();
  });

  it("blocks CI isolated replay artifacts outside the configured managed root before reset starts", async () => {
    teachSaveWorkflow();
    const managedArtifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-managed-artifacts-"));
    process.env["SYNTHI_WORKFLOW_CI_ARTIFACT_DIR"] = managedArtifactRoot;
    const requestedArtifactRoot = path.join(path.dirname(managedArtifactRoot), `${path.basename(managedArtifactRoot)}-outside`);
    const workingDirectory = path.join(managedArtifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const resetMarkerPath = path.join(managedArtifactRoot, "reset-ran");
    const resetScript = path.join(managedArtifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(managedArtifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(managedArtifactRoot, "ci.mjs");
    const postconditionScript = path.join(managedArtifactRoot, "postcondition.mjs");
    await writeFile(resetScript, [
      "import { writeFile } from 'node:fs/promises';",
      `await writeFile(${JSON.stringify(resetMarkerPath)}, 'ran');`,
      "",
    ].join("\n"));
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, "process.exit(0);\n");
    await writeFile(postconditionScript, "process.exit(0);\n");

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: requestedArtifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    const body = replay?.structuredContent as {
      ok: boolean;
      replay: {
        status: string;
        failure_stage: string;
        blockers: string[];
        artifacts: { directory: string };
        commands: { reset_exit_code: number | null };
      };
    };
    expect(body).toEqual(expect.objectContaining({ ok: false }));
    expect(body.replay).toEqual(expect.objectContaining({
      status: "blocked",
      failure_stage: "profile",
      blockers: expect.arrayContaining(["invalid_artifact_root"]),
      commands: expect.objectContaining({ reset_exit_code: null }),
    }));
    expect(body.replay.artifacts.directory.startsWith(path.join(managedArtifactRoot, "rejected-artifact-root"))).toBe(true);
    await expect(access(resetMarkerPath)).rejects.toThrow();
    await expect(access(requestedArtifactRoot)).rejects.toThrow();
  });

  it("fails CI isolated replay when a passing command omits mutation attestation", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-missing-attestation-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(resetScript, "process.exit(0);\n");
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, [
      "import { readFile } from 'node:fs/promises';",
      "const spec = await readFile(process.env.SYNTHI_WORKFLOW_SPEC, 'utf8');",
      "if (!spec.includes('recordWorkflowStep(\"browser_evt_2\")')) throw new Error('mutation_attestation_not_generated');",
      "process.exit(0);",
      "",
    ].join("\n"));
    await writeFile(postconditionScript, "process.exit(0);\n");

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        mutation_executed: false,
        failure_class: "appValidationError",
        failure_stage: "attestation",
        report: expect.objectContaining({
          attested_step_ids: [],
          missing_mutation_step_ids: ["browser_evt_2"],
        }),
      }),
    }));
  });

  it("rejects stale mutation attestation from a different CI replay run", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-stale-attestation-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(resetScript, "process.exit(0);\n");
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, [
      "import { appendFile } from 'node:fs/promises';",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_1', run_id: 'old-run', nonce: 'old-nonce' }) + '\\n', 'utf8');",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_2', run_id: 'old-run', nonce: 'old-nonce' }) + '\\n', 'utf8');",
      "",
    ].join("\n"));
    await writeFile(postconditionScript, "process.exit(0);\n");

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        mutation_executed: false,
        failure_stage: "attestation",
        report: expect.objectContaining({
          attested_step_ids: [],
          missing_mutation_step_ids: ["browser_evt_2"],
        }),
      }),
    }));
  });

  it("fails CI isolated replay when attested mutation omits visual proof", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-no-visual-proof-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(resetScript, "process.exit(0);\n");
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, [
      "import { appendFile } from 'node:fs/promises';",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_1', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_2', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      "",
    ].join("\n"));
    await writeFile(postconditionScript, "process.exit(0);\n");

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        mutation_executed: true,
        failure_class: "appValidationError",
        failure_stage: "visual_proof",
        commands: expect.objectContaining({
          ci_exit_code: 0,
          postcondition_exit_code: null,
        }),
        report: expect.objectContaining({
          missing_mutation_step_ids: [],
        }),
      }),
    }));
  });

  it("classifies reset profile assertion mismatch as missing test data", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-profile-mismatch-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const markerPath = path.join(artifactRoot, "marker.json");
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(resetScript, [
      "import { writeFile } from 'node:fs/promises';",
      `await writeFile(${JSON.stringify(markerPath)}, JSON.stringify({ reset: true, resetProfileId: 'wrong-profile' }));`,
      "",
    ].join("\n"));
    await writeFile(resetAssertionScript, [
      "import { readFile } from 'node:fs/promises';",
      `const marker = JSON.parse(await readFile(${JSON.stringify(markerPath)}, 'utf8'));`,
      "if (marker.resetProfileId !== process.env.SYNTHI_WORKFLOW_CI_RESET_PROFILE_ID) throw new Error('reset_profile_mismatch');",
      "",
    ].join("\n"));
    await writeFile(ciScript, "process.exit(0);\n");
    await writeFile(postconditionScript, "process.exit(0);\n");

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        mutation_executed: false,
        failure_class: "testDataMissing",
        failure_stage: "reset_assertion",
        commands: expect.objectContaining({
          reset_exit_code: 0,
          reset_assertion_exit_code: 1,
          ci_exit_code: null,
        }),
        report: expect.objectContaining({
          reset_assertion_output: expect.stringContaining("reset_profile_mismatch"),
        }),
      }),
    }));
  });

  it("fails CI isolated replay when the postcondition command fails", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-postcondition-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(resetScript, "process.exit(0);\n");
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, [
      "import { appendFile, writeFile } from 'node:fs/promises';",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_2', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      ...visualProofScriptLines(),
      "",
    ].join("\n"));
    await writeFile(postconditionScript, "throw new Error('saved_status_missing');\n");

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        mutation_executed: true,
        failure_class: "appValidationError",
        failure_stage: "postcondition",
        commands: expect.objectContaining({ postcondition_exit_code: 1 }),
        report: expect.objectContaining({
          postcondition_output: expect.stringContaining("saved_status_missing"),
          missing_mutation_step_ids: [],
        }),
      }),
    }));
  });

  it("classifies CI postcondition reset profile mismatches as missing test data", async () => {
    teachSaveWorkflow();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-replay-postcondition-profile-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(resetScript, "process.exit(0);\n");
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, [
      "import { appendFile, writeFile } from 'node:fs/promises';",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_2', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      ...visualProofScriptLines(),
      "",
    ].join("\n"));
    await writeFile(postconditionScript, "throw new Error('reset_profile_id_mismatch');\n");

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-a",
      kind: "ciIsolated",
      base_url: "https://ci.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      reset_profile_id: "settings-reset-v1",
      state_seed_id: "settings-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-a",
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "failed",
        mutation_executed: true,
        failure_class: "testDataMissing",
        failure_stage: "postcondition",
        commands: expect.objectContaining({ postcondition_exit_code: 1 }),
        report: expect.objectContaining({
          postcondition_output: expect.stringContaining("reset_profile_id_mismatch"),
          missing_mutation_step_ids: [],
        }),
      }),
    }));
  });

  it("passes validated auth provider storage state into CI isolated replay", async () => {
    const url = "https://app.example.test/settings";
    const appOrigin = "https://app.example.test";
    const mintedStorageState: AuthBrowserStorageState = {
      cookies: [{ name: "sid", value: "auth-cookie-validation-secret", domain: "app.example.test", path: "/", httpOnly: true, secure: true }],
      origins: [{ origin: appOrigin, localStorage: [{ name: "session", value: "auth-local-validation-secret" }], sessionStorage: [{ name: "tab", value: "auth-tab-validation-secret" }] }],
    };
    const replayStorageState: AuthBrowserStorageState = {
      cookies: [{ name: "sid", value: "auth-cookie-replay-secret", domain: "app.example.test", path: "/", httpOnly: true, secure: true }],
      origins: [{ origin: appOrigin, localStorage: [{ name: "session", value: "auth-local-replay-secret" }], sessionStorage: [{ name: "tab", value: "auth-tab-replay-secret" }] }],
    };
    const interactiveStorageState: AuthBrowserStorageState = {
      cookies: [{ name: "sid", value: "interactive-secret", domain: "app.example.test", path: "/" }],
      origins: [{ origin: appOrigin, localStorage: [{ name: "session", value: "interactive-secret" }] }],
    };
    const mintedAuthValues = authStorageValuesForTest(replayStorageState);
    const allSensitiveAuthValues = [...new Set([
      ...authStorageValuesForTest(mintedStorageState),
      ...mintedAuthValues,
      ...authStorageValuesForTest(interactiveStorageState),
    ])];
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "synthi-ci-auth-replay-"));
    const workingDirectory = path.join(artifactRoot, "workspace");
    await mkdir(workingDirectory, { recursive: true });
    const storageStateMarkerPath = path.join(artifactRoot, "storage-state-handoff.json");
    const mintCountPath = path.join(artifactRoot, "mint-count.txt");
    const mintScript = path.join(artifactRoot, "mint-auth.mjs");
    const resetScript = path.join(artifactRoot, "reset.mjs");
    const resetAssertionScript = path.join(artifactRoot, "reset-assertion.mjs");
    const ciScript = path.join(artifactRoot, "ci.mjs");
    const postconditionScript = path.join(artifactRoot, "postcondition.mjs");
    await writeFile(mintScript, [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "const appOrigin = process.env.SYNTHI_AUTH_APP_ORIGIN;",
      `const mintCountPath = ${JSON.stringify(mintCountPath)};`,
      "let count = 0;",
      "try { count = Number(await readFile(mintCountPath, 'utf8')) || 0; } catch { count = 0; }",
      "count += 1;",
      "await writeFile(mintCountPath, String(count));",
      `const storageState = count <= 1 ? ${JSON.stringify(mintedStorageState)} : ${JSON.stringify(replayStorageState)};`,
      "if (storageState.origins?.[0]) storageState.origins[0].origin = appOrigin;",
      "const output = JSON.stringify({ ok: true, ttl_ms: 600000, storage_state: storageState });",
      "if (process.env.SYNTHI_AUTH_PROVIDER_OUTPUT_PATH) {",
      "  const { writeFileSync } = await import('node:fs');",
      "  writeFileSync(process.env.SYNTHI_AUTH_PROVIDER_OUTPUT_PATH, output);",
      "}",
      "process.stdout.write(output);",
      "",
    ].join("\n"));
    await writeFile(resetScript, "process.exit(0);\n");
    await writeFile(resetAssertionScript, "process.exit(0);\n");
    await writeFile(ciScript, [
      "import { appendFile, readFile, writeFile } from 'node:fs/promises';",
      `const expectedAuthValues = ${JSON.stringify(mintedAuthValues)};`,
      "if (!process.env.SYNTHI_WORKFLOW_STORAGE_STATE) throw new Error('storage_state_path_missing');",
      `await writeFile(${JSON.stringify(storageStateMarkerPath)}, JSON.stringify({ storageStatePath: process.env.SYNTHI_WORKFLOW_STORAGE_STATE }), 'utf8');`,
      "const storage = JSON.parse(await readFile(process.env.SYNTHI_WORKFLOW_STORAGE_STATE, 'utf8'));",
      "const serializedStorage = JSON.stringify(storage);",
      "for (const value of expectedAuthValues) {",
      "  if (!serializedStorage.includes(value)) throw new Error('auth_storage_value_missing');",
      "}",
      "process.stdout.write(`Authorization: Bearer ${expectedAuthValues[0]}\\n`);",
      "process.stdout.write(`token=${expectedAuthValues[1]} session=${expectedAuthValues[2]}\\n`);",
      "process.stdout.write(`bare values: ${expectedAuthValues.join(' ')}\\n`);",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_1', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      "await appendFile(process.env.SYNTHI_WORKFLOW_REPLAY_ATTESTATION, JSON.stringify({ step_id: 'browser_evt_2', run_id: process.env.SYNTHI_WORKFLOW_CI_RUN_ID, nonce: process.env.SYNTHI_WORKFLOW_CI_NONCE }) + '\\n', 'utf8');",
      ...visualProofScriptLines(),
      "",
    ].join("\n"));
    await writeFile(postconditionScript, "process.exit(0);\n");

    const enrollment = authCheckpointManager.beginEnrollment(url);
    const checkpoint = authCheckpointManager.finishEnrollment({ enrollment_id: enrollment.enrollment_id, ttl_ms: 600_000 });
    if (!checkpoint.ok) throw new Error(checkpoint.error);
    const stored = authCheckpointManager.saveStorageArtifact({
      checkpoint_id: checkpoint.checkpoint.checkpoint_id,
      storage_state: interactiveStorageState,
    });
    if (!stored.ok) throw new Error(stored.error);
    teachSaveWorkflow();

    const provider = authCheckpointManager.configureRefreshProvider({
      url,
      provider_type: "ciTestAuth",
      secret_ref: "synthi://secrets/workspace/ci-auth",
      mint_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(mintScript)}`,
      mint_command_admin_approved: true,
      working_directory: workingDirectory,
    });
    if (!provider.ok) throw new Error(provider.error);
    const tested = await authCheckpointManager.testRefreshProvider(provider.provider.provider_id);
    expect(tested).toEqual(expect.objectContaining({ can_mint_replay_state: true }));

    await dispatchSafetyTool("synthi_safety_set_replay_isolation_profile", {
      workspace_id: "workspace-auth",
      kind: "ciIsolated",
      base_url: "https://app.example.test",
      working_directory: workingDirectory,
      data_reset_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetScript)}`,
      reset_assertion_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(resetAssertionScript)}`,
      ci_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(ciScript)}`,
      postcondition_command: `${JSON.stringify(process.execPath)} ${JSON.stringify(postconditionScript)}`,
      auth_provider_id: provider.provider.provider_id,
      reset_profile_id: "auth-reset-v1",
      state_seed_id: "auth-fixture-v1",
      allow_mutation_replay: true,
    });

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", {
      workspace_id: "workspace-auth",
      parameters: { email: "ada@example.test" },
      artifact_root: artifactRoot,
    });

    expect(replay?.isError).toBeUndefined();
    const body = replay?.structuredContent as {
      ok: boolean;
      replay: {
        status: string;
        artifacts: { auth_storage_state_path?: string; ci_log_path: string };
        report: {
          ci_output: string;
          auth_storage_state: {
            cookie_count: number;
            origin_count: number;
            local_storage_entry_count: number;
            session_storage_entry_count: number;
          } | null;
          attested_step_ids: string[];
        };
      };
    };
    expect(body).toEqual(expect.objectContaining({ ok: true }));
    expect(body.replay.status).toBe("passed");
    expect(body.replay.artifacts.auth_storage_state_path).toBeUndefined();
    expect(JSON.stringify(body.replay.artifacts)).not.toContain("auth-storage-state");
    expect(body.replay.report.auth_storage_state).toEqual({
      cookie_count: 1,
      origin_count: 1,
      local_storage_entry_count: 1,
      session_storage_entry_count: 1,
    });
    expect(body.replay.report.attested_step_ids).toEqual(["browser_evt_1", "browser_evt_2"]);
    const ciLog = await readFile(body.replay.artifacts.ci_log_path, "utf8");
    for (const value of allSensitiveAuthValues) {
      expect(JSON.stringify(body)).not.toContain(value);
      expect(ciLog).not.toContain(value);
    }
    if (body.replay.report.ci_output.length > 0 || ciLog.length > 0) {
      expect(`${body.replay.report.ci_output}\n${ciLog}`).toContain("[redacted]");
    }
    const storageStateHandoff = JSON.parse(await readFile(storageStateMarkerPath, "utf8")) as { storageStatePath: string };
    expect(storageStateHandoff.storageStatePath).toContain(".internal-auth-state");
    await expect(access(storageStateHandoff.storageStatePath)).rejects.toThrow();
    await expect(access(path.dirname(storageStateHandoff.storageStatePath))).rejects.toThrow();
    await expect(access(path.join(artifactRoot, ".internal-auth-state"))).rejects.toThrow();
  });

  it("blocks CI isolated replay before profile readiness instead of executing mutation steps", async () => {
    teachSaveWorkflow();

    const replay = await dispatchSafetyTool("synthi_safety_run_ci_isolated_replay", { workspace_id: "workspace-a" });

    expect(replay?.isError).toBeUndefined();
    expect(replay?.structuredContent).toEqual(expect.objectContaining({
      ok: false,
      replay: expect.objectContaining({
        status: "blocked",
        mutation_executed: false,
        failure_class: "mutationBlocked",
        blockers: expect.arrayContaining(["ci_isolation_profile_not_ready", "mutation_replay_not_explicitly_allowed"]),
      }),
    }));
  });
});

function teachSaveWorkflow(): void {
  const url = "https://app.example.test/settings";
  browserBroker.requestConsent(url, "granted", "unit", { screenshot: true, diagnostics: true });
  browserBroker.registerTabs([{ tab_id: "tab-a", url, active: true }]);
  expect(browserBroker.startTeachMode("tab-a").ok).toBe(true);
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin: "https://app.example.test",
    action: "fill",
    value: "hello@example.test",
    field_name: "email",
    element: { tag: "input", label: "Email", source_id: "s_email" },
  });
  browserBroker.recordHumanAction({
    tab_id: "tab-a",
    url,
    origin: "https://app.example.test",
    action: "click",
    element: { tag: "button", role: "button", name: "Save settings", source_id: "s_save" },
  });
}

function authStorageValuesForTest(storageState: AuthBrowserStorageState): string[] {
  const values = new Set<string>();
  for (const cookie of storageState.cookies ?? []) {
    if (cookie.value.length > 0) values.add(cookie.value);
  }
  for (const origin of storageState.origins ?? []) {
    for (const entry of origin.localStorage ?? []) {
      if (entry.value.length > 0) values.add(entry.value);
    }
    for (const entry of origin.sessionStorage ?? []) {
      if (entry.value.length > 0) values.add(entry.value);
    }
  }
  return [...values];
}
