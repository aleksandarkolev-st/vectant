import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AgentWorkflowPanel, {
  WORKFLOW_ACTIONS,
  createDefaultWorkflowViewModel,
  deriveWorkflowPanelSummary,
  normalizeWorkflowPanelState,
} from '../AgentWorkflowPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = undefined;
  }
  if (container) {
    container.remove();
    container = undefined;
  }
});

function renderPanel(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<AgentWorkflowPanel {...props} />);
  });
  return container;
}

function setNativeInputValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value');
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AgentWorkflowPanel view model', () => {
  it('starts from the hosted runtime attach path without local dev harness assumptions', () => {
    const model = createDefaultWorkflowViewModel();
    const summary = deriveWorkflowPanelSummary(model);

    expect(WORKFLOW_ACTIONS.COMPILE_CONTRACT).toBe('synthi_browser_compile_workflow');
    expect(WORKFLOW_ACTIONS.RUN_CHECKRIDE).toBe('synthi_dojo_run_checkride');
    expect(WORKFLOW_ACTIONS.GET_MUTATION_PLAN).toBe('synthi_safety_get_mutation_plan');
    expect(WORKFLOW_ACTIONS.SET_REPLAY_ISOLATION_PROFILE).toBe('synthi_safety_set_replay_isolation_profile');
    expect(WORKFLOW_ACTIONS.PREFIX_VALIDATE).toBe('synthi_safety_run_prefix_validation');
    expect(WORKFLOW_ACTIONS.RUN_CI_ISOLATED_REPLAY).toBe('synthi_safety_run_ci_isolated_replay');
    expect(WORKFLOW_ACTIONS.GENERATE_SCRIPT).toBe('synthi_browser_generate_script');
    expect(WORKFLOW_ACTIONS.PUBLISH_TOOL).toBe('synthi_dojo_publish_skill');
    expect(WORKFLOW_ACTIONS.GET_UNIVERSE_DOSSIER).toBe('synthi_dojo_get_universe_dossier');
    expect(WORKFLOW_ACTIONS.RUN_VIVARIUM_SCENARIO).toBe('synthi_dojo_run_vivarium_scenario');
    expect(WORKFLOW_ACTIONS.RUN_WIND_TUNNEL).toBe('synthi_dojo_run_wind_tunnel');
    expect(WORKFLOW_ACTIONS.GET_LICENSE_HEALTH).toBe('synthi_dojo_get_license_health');
    expect(model.workspaceLabel).toBe('Current workspace');
    expect(summary.primaryAction).toBe(WORKFLOW_ACTIONS.ATTACH_WORKSPACE);
    expect(summary.primaryEnabled).toBe(true);
    expect(summary.enabledActions).toContain(WORKFLOW_ACTIONS.ATTACH_WORKSPACE);
    expect(summary.enabledActions).not.toContain(WORKFLOW_ACTIONS.BEGIN_TEACH);
    expect(JSON.stringify(model)).not.toMatch(/cdp|chrome|localhost|browser-mcp-live/i);
  });

  it('uses the workspace supplied by the host and enables teaching after observe', () => {
    const model = normalizeWorkflowPanelState(
      {
        runtime: { status: 'ready', detail: 'Attached to a hosted workspace browser.' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
      },
      'developer-workspace',
    );
    const summary = deriveWorkflowPanelSummary(model);

    expect(model.workspaceLabel).toBe('developer-workspace');
    expect(summary.primaryAction).toBe(WORKFLOW_ACTIONS.BEGIN_TEACH);
    expect(summary.enabledActions).toContain(WORKFLOW_ACTIONS.BEGIN_TEACH);
  });

  it('keeps unresolved workflow questions visible before publish', () => {
    const model = normalizeWorkflowPanelState(
      {
        runtime: { status: 'ready' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
        workflow: {
          title: 'Save workspace state',
          stepCount: 2,
          unresolvedCount: 1,
          contractStatus: 'compiled',
          scriptStatus: 'generated',
        },
        steps: [
          { id: 'open', label: 'Open preview', state: 'recorded' },
          { id: 'save', label: 'Save state', state: 'limited' },
        ],
        unresolvedSteps: [{ id: 'save', label: 'Save state', detail: 'Needs a stable mutation boundary.' }],
      },
      'developer-workspace',
    );
    const summary = deriveWorkflowPanelSummary(model);

    expect(summary.stepCount).toBe(2);
    expect(summary.blockerCount).toBe(1);
    expect(summary.canPublish).toBe(false);
    expect(model.unresolvedSteps).toHaveLength(1);
  });

  it('surfaces ready CI isolation profiles as workflow actions', () => {
    const model = normalizeWorkflowPanelState(
      {
        runtime: { status: 'ready' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
        workflow: {
          title: 'Publish release',
          stepCount: 2,
          contractStatus: 'compiled',
          scriptStatus: 'generated',
        },
        profile_manifest: {
          schema_version: 'synthi.replayIsolationProfile.v1',
          readiness: 'ciIsolatedReady',
          can_run_full_mutation_replay: true,
          reset_profile_id: 'release-reset-v1',
          state_seed_id: 'release-fixture-v1',
          base_url: 'https://preview.example.test',
          commands: {
            ci: 'npm run workflow:ci',
            data_reset: 'npm run workflow:reset',
            reset_assertion: 'npm run workflow:assert-reset',
            postcondition: 'npm run assert:release',
          },
          missing: [],
        },
        mutation_plan: {
          has_mutation: true,
          ci_full_replay: { allowed: true, blockers: [] },
        },
      },
      'developer-workspace',
    );
    const summary = deriveWorkflowPanelSummary(model);

    expect(model.isolation).toEqual(expect.objectContaining({
      canRunFullMutationReplay: true,
      resetProfileId: 'release-reset-v1',
      stateSeedId: 'release-fixture-v1',
      baseUrl: 'https://preview.example.test',
      ciCommand: 'npm run workflow:ci',
      dataResetCommand: 'npm run workflow:reset',
      resetAssertionCommand: 'npm run workflow:assert-reset',
      postconditionCommand: 'npm run assert:release',
      postconditionConfigured: true,
    }));
    expect(summary.enabledActions).toContain(WORKFLOW_ACTIONS.RUN_CI_ISOLATED_REPLAY);
  });

  it('normalizes Dojo skill cards and proof-carrying license state', () => {
    const model = normalizeWorkflowPanelState(
      {
        runtime: { status: 'ready' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
        workflow: {
          title: 'Save workspace state',
          stepCount: 2,
          contractStatus: 'compiled',
          scriptStatus: 'generated',
        },
        dojo: {
          status: 'licensed',
          published: true,
          skillId: 'dojo_save_settings',
          entrustmentLevel: 'E3',
          readinessLevel: 7,
          proofRequired: true,
          publishedToolName: 'synthi_app_save_settings',
          scenarioCount: 20,
          skillCard: {
            title: 'Save settings',
            status: 'Licensed E3',
            can_do_alone: ['run_workflow'],
            will_ask_before: ['commit_mutation'],
            will_not_do: ['delete'],
            practiced: '20 synthetic cases',
            found_and_fixed: '2 guardrails',
            proof_badge: 'Proof required',
          },
          license: {
            allowedActions: ['run_workflow'],
            gatedActions: ['commit_mutation'],
            blockedActions: ['delete'],
          },
          lifecycle: { status: 'active', daysUntilExpiry: 23, recertificationRequired: false },
          governance: { approvalCount: 1, policyGateCount: 3, evidenceClaims: ['guardrails_active'] },
          metrics: { coverage: 0.9, proofRequiredPercent: 1, mcpBackedSkillCount: 1 },
          sourceAffordancePrPlan: { readiness: 'ready_for_review', patchCount: 2 },
          windTunnel: { runCount: 20, passCount: 18, blockedCount: 2 },
          licenseHealth: { status: 'active', proofRecords: { issued: 1 } },
        },
      },
      'developer-workspace',
    );
    const summary = deriveWorkflowPanelSummary(model);

    expect(model.dojo).toEqual(expect.objectContaining({
      status: 'licensed',
      skillId: 'dojo_save_settings',
      entrustmentLevel: 'E3',
      readinessLevel: 7,
      proofRequired: true,
      publishedToolName: 'synthi_app_save_settings',
      lifecycle: expect.objectContaining({ status: 'active', daysUntilExpiry: 23 }),
      sourceAffordancePrPlan: expect.objectContaining({ patchCount: 2 }),
      windTunnel: expect.objectContaining({ runCount: 20 }),
      skillCard: expect.objectContaining({
        canDoAlone: ['run_workflow'],
        willAskBefore: ['commit_mutation'],
        willNotDo: ['delete'],
      }),
    }));
    expect(summary.enabledActions).toContain(WORKFLOW_ACTIONS.RUN_CHECKRIDE);
    expect(summary.enabledActions).toContain(WORKFLOW_ACTIONS.GET_UNIVERSE_DOSSIER);
    expect(summary.enabledActions).toContain(WORKFLOW_ACTIONS.RUN_WIND_TUNNEL);
    expect(summary.canPublish).toBe(true);
  });
});

describe('AgentWorkflowPanel rendering', () => {
  it('renders the operational sections and dispatches host workflow actions', () => {
    const onWorkflowAction = vi.fn();
    const eventListener = vi.fn();
    window.addEventListener('synthi:agent-workflow-action', eventListener);

    const panel = renderPanel({
      workspaceSlug: 'developer-workspace',
      onWorkflowAction,
      workflowState: {
        runtime: { status: 'ready' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
      },
    });

    expect(panel.textContent).toContain('Workflows');
    expect(panel.textContent).toContain('Hosted browser runtime');
    expect(panel.textContent).toContain('Screenshot consent');
    expect(panel.textContent).toContain('Workflow teaching');

    const teachButton = [...panel.querySelectorAll('button')]
      // The stage row has a selector button and an action button; only the
      // action button (no data-workflow-stage-selector) dispatches actions.
      .filter((button) => !button.hasAttribute('data-workflow-stage-selector'))
      .find((button) => button.textContent.includes('Teach'));
    expect(teachButton).toBeTruthy();

    act(() => {
      teachButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onWorkflowAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: WORKFLOW_ACTIONS.BEGIN_TEACH,
        workspaceSlug: 'developer-workspace',
      }),
    );
    expect(eventListener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({
          action: WORKFLOW_ACTIONS.BEGIN_TEACH,
          workspaceSlug: 'developer-workspace',
        }),
      }),
    );
    expect(panel.textContent).toContain('Teaching');

    window.removeEventListener('synthi:agent-workflow-action', eventListener);
  });

  it('labels unresolved workflow items as publish hardening', () => {
    const panel = renderPanel({
      workspaceSlug: 'developer-workspace',
      workflowState: {
        runtime: { status: 'ready' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
        workflow: {
          title: 'Save workspace state',
          stepCount: 2,
          unresolvedCount: 1,
          contractStatus: 'compiled',
          scriptStatus: 'generated',
        },
        unresolvedSteps: [{ id: 'save', label: 'Save state', detail: 'Needs publish hardening: mutationRequiresIsolation.' }],
      },
    });

    expect(panel.textContent).toContain('Publish Hardening');
    expect(panel.textContent).toContain('Needs publish hardening');
    expect(panel.textContent).not.toContain('Review Queue');
  });

  it('renders CI replay profile readiness and dispatches isolated replay', () => {
    const onWorkflowAction = vi.fn();
    const panel = renderPanel({
      workspaceSlug: 'developer-workspace',
      onWorkflowAction,
      workflowState: {
        runtime: { status: 'ready' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
        workflow: {
          title: 'Publish release',
          stepCount: 2,
          contractStatus: 'compiled',
          scriptStatus: 'generated',
        },
        profile_manifest: {
          schema_version: 'synthi.replayIsolationProfile.v1',
          readiness: 'ciIsolatedReady',
          can_run_full_mutation_replay: true,
          reset_profile_id: 'release-reset-v1',
          state_seed_id: 'release-fixture-v1',
          commands: { postcondition: 'npm run assert:release' },
          missing: [],
        },
        mutation_plan: {
          has_mutation: true,
          ci_full_replay: { allowed: true, blockers: [] },
        },
      },
    });

    expect(panel.textContent).toContain('CI replay profile');
    expect(panel.textContent).toContain('release-reset-v1');
    expect(panel.textContent).toContain('release-fixture-v1');
    expect(panel.textContent).toContain('Configured');

    const replayButton = [...panel.querySelectorAll('button')].find((button) => button.textContent.includes('CI replay'));
    expect(replayButton).toBeTruthy();

    act(() => {
      replayButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onWorkflowAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: WORKFLOW_ACTIONS.RUN_CI_ISOLATED_REPLAY,
        workspaceSlug: 'developer-workspace',
      }),
    );
  });

  it('renders Dojo credential state and dispatches checkride and license actions', () => {
    const onWorkflowAction = vi.fn();
    const panel = renderPanel({
      workspaceSlug: 'developer-workspace',
      onWorkflowAction,
      workflowState: {
        runtime: { status: 'ready' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
        workflow: {
          title: 'Save workspace state',
          stepCount: 2,
          contractStatus: 'compiled',
          scriptStatus: 'generated',
        },
        dojo: {
          status: 'licensed',
          published: true,
          skillId: 'dojo_save_settings',
          entrustmentLevel: 'E3',
          readinessLevel: 7,
          proofRequired: true,
          publishedToolName: 'synthi_app_save_settings',
          scenarioCount: 20,
          checkride: { coverageScore: 0.9 },
          lifecycle: { status: 'active', daysUntilExpiry: 23 },
          sourceAffordancePrPlan: { readiness: 'ready_for_review', patchCount: 2 },
          windTunnel: { runCount: 20, passCount: 18, blockedCount: 2 },
          vivariumRun: { scenarioTitle: 'Duplicate entity check', status: 'blocked', syntheticDataOnly: true },
          timeMachine: { changedVariable: 'stable_entity_identity', expectedStatusAfterChange: 'blocked' },
          governance: { approvalCount: 1, policyGateCount: 3 },
          caseLawRecord: { title: 'Operator Review Required', status: 'binding' },
          skillCard: {
            title: 'Save settings',
            status: 'Licensed E3',
            can_do_alone: ['run_workflow'],
            will_ask_before: ['commit_mutation'],
            will_not_do: ['delete'],
            practiced: '20 synthetic cases',
            found_and_fixed: '2 guardrails',
            proof_badge: 'Proof required',
          },
        },
      },
    });

    expect(panel.textContent).toContain('Dojo Skill');
    expect(panel.textContent).toContain('SRL 7');
    expect(panel.textContent).toContain('90% coverage');
    expect(panel.textContent).toContain('20 synthetic cases');
    expect(panel.textContent).toContain('synthi_app_save_settings');
    expect(panel.textContent).toContain('active');
    expect(panel.textContent).toContain('2 patches');
    expect(panel.textContent).toContain('20 runs');
    expect(panel.textContent).toContain('Duplicate entity check');
    expect(panel.textContent).toContain('stable_entity_identity');
    expect(panel.textContent).toContain('Operator Review Required');
    expect(panel.textContent).toContain('Dojo Export');
    // Current copy for GET_UNIVERSE_DOSSIER / RUN_WIND_TUNNEL actions.
    expect(panel.textContent).toContain('Capability');
    expect(panel.textContent).toContain('Practice');
    expect(panel.textContent).toContain('Hardening');
    expect([...panel.querySelectorAll('button')]
      .filter((button) => button.textContent.trim() === 'Export')).toHaveLength(1);

    // Dojo debug actions live inside the Dojo card; scope the lookup so
    // section navigation sharing the same words never matches first.
    const dojoCard = panel.querySelector('[data-testid="agent-workflow-dojo"]');
    expect(dojoCard).toBeTruthy();
    const findActionButton = (label) => [...dojoCard.querySelectorAll('button')]
      .filter((button) => !button.hasAttribute('data-workflow-stage-selector'))
      .find((button) => button.textContent.includes(label));
    const checkrideButton = findActionButton('Checkride');
    const licenseButton = findActionButton('Relicense');
    const universeButton = findActionButton('Capability');
    const practiceButton = findActionButton('Practice');
    const windButton = findActionButton('Hardening');
    const healthButton = findActionButton('Health');

    expect(checkrideButton).toBeTruthy();
    expect(licenseButton).toBeTruthy();
    expect(universeButton).toBeTruthy();
    expect(practiceButton).toBeTruthy();
    expect(windButton).toBeTruthy();
    expect(healthButton).toBeTruthy();

    act(() => {
      checkrideButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      licenseButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      universeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      practiceButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      windButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      healthButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onWorkflowAction).toHaveBeenCalledWith(expect.objectContaining({
      action: WORKFLOW_ACTIONS.RUN_CHECKRIDE,
      workspaceSlug: 'developer-workspace',
    }));
    expect(onWorkflowAction).toHaveBeenCalledWith(expect.objectContaining({
      action: WORKFLOW_ACTIONS.PUBLISH_TOOL,
      workspaceSlug: 'developer-workspace',
    }));
    expect(onWorkflowAction).toHaveBeenCalledWith(expect.objectContaining({
      action: WORKFLOW_ACTIONS.GET_UNIVERSE_DOSSIER,
      workspaceSlug: 'developer-workspace',
    }));
    expect(onWorkflowAction).toHaveBeenCalledWith(expect.objectContaining({
      action: WORKFLOW_ACTIONS.RUN_VIVARIUM_SCENARIO,
      workspaceSlug: 'developer-workspace',
    }));
    expect(onWorkflowAction).toHaveBeenCalledWith(expect.objectContaining({
      action: WORKFLOW_ACTIONS.RUN_WIND_TUNNEL,
      workspaceSlug: 'developer-workspace',
    }));
    expect(onWorkflowAction).toHaveBeenCalledWith(expect.objectContaining({
      action: WORKFLOW_ACTIONS.GET_LICENSE_HEALTH,
      workspaceSlug: 'developer-workspace',
    }));
  });

  it('edits CI replay profiles through the portable manifest action', () => {
    const onWorkflowAction = vi.fn();
    const panel = renderPanel({
      workspaceSlug: 'developer-workspace',
      onWorkflowAction,
      workflowState: {
        runtime: { status: 'ready' },
        observe: { status: 'ready', lastScreenshotAt: '2026-06-04T00:00:00.000Z' },
        workflow: {
          title: 'Publish release',
          stepCount: 2,
          contractStatus: 'compiled',
          scriptStatus: 'generated',
        },
        profile_manifest: {
          schema_version: 'synthi.replayIsolationProfile.v1',
          readiness: 'ciIsolatedIncomplete',
          can_run_full_mutation_replay: false,
          base_url: 'https://preview.example.test',
          reset_profile_id: 'release-reset-v1',
          state_seed_id: 'release-fixture-v1',
          commands: {
            ci: 'npm run workflow:ci',
            data_reset: 'npm run workflow:reset',
            reset_assertion: 'npm run workflow:assert-reset',
          },
          missing: ['postcondition_command', 'allow_mutation_replay'],
        },
        mutation_plan: {
          has_mutation: true,
          ci_full_replay: { allowed: false, blockers: ['postcondition_command', 'allow_mutation_replay'] },
        },
      },
    });

    const postcondition = [...panel.querySelectorAll('textarea')]
      .find((input) => input.closest('label')?.textContent.includes('Postcondition'));
    // The mutation-replay consent is a role="switch" button in the form.
    const allowMutation = [...panel.querySelectorAll('button[role="switch"]')]
      .find((button) => button.textContent.includes('Allow mutation replay'));
    const saveButton = [...panel.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Save profile'));

    expect(postcondition).toBeTruthy();
    expect(allowMutation).toBeTruthy();
    expect(saveButton).toBeTruthy();

    // Two separate user ticks: flipping the switch must commit before
    // Save reads the form, exactly like real interaction timing.
    act(() => {
      allowMutation.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      setNativeInputValue(postcondition, 'npm run workflow:assert-saved');
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onWorkflowAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: WORKFLOW_ACTIONS.SET_REPLAY_ISOLATION_PROFILE,
        workspaceSlug: 'developer-workspace',
        payload: {
          profile_manifest: expect.objectContaining({
            schema_version: 'synthi.replayIsolationProfile.v1',
            kind: 'ciIsolated',
            base_url: 'https://preview.example.test',
            reset_profile_id: 'release-reset-v1',
            state_seed_id: 'release-fixture-v1',
            allow_mutation_replay: true,
            commands: expect.objectContaining({
              ci: 'npm run workflow:ci',
              data_reset: 'npm run workflow:reset',
              reset_assertion: 'npm run workflow:assert-reset',
              postcondition: 'npm run workflow:assert-saved',
            }),
          }),
        },
      }),
    );
  });
});

describe('Observe world picker (five verbs, zero jargon)', () => {
  it('shows plain-language places, never internal vocabulary', () => {
    const panel = renderPanel({
      workspaceSlug: 'developer-workspace',
      workflowState: {
        runtime: { status: 'ready' },
        substrates: ['browser', 'terminal', 'runtime', 'game', 'kernel'],
      },
    });

    const picker = panel.querySelector('[data-workflow-substrate-picker="observe"]');
    expect(picker).toBeTruthy();
    const options = [...picker.querySelectorAll('option')].map((option) => option.textContent);
    // Human labels for every registered kind...
    expect(options).toContain('This workspace preview');
    expect(options).toContain('A terminal here');
    expect(options).toContain('Programs and notebooks');
    expect(options).toContain('A game world');
    expect(options).toContain('System internals (careful)');
    // ...and zero jargon anywhere in the picker.
    expect(options.join('|')).not.toMatch(/substrate|adapter|realm|lease/i);
  });

  it('dispatches the chosen place so the host can attach and observe', () => {
    const onWorkflowAction = vi.fn();
    const panel = renderPanel({
      workspaceSlug: 'developer-workspace',
      onWorkflowAction,
      workflowState: {
        runtime: { status: 'ready' },
        substrates: ['terminal'],
      },
    });

    const picker = panel.querySelector('[data-workflow-substrate-picker="observe"]');
    expect(picker).toBeTruthy();

    act(() => {
      setNativeInputValue(picker, 'terminal');
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(onWorkflowAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: WORKFLOW_ACTIONS.LIST_SUBSTRATES,
        payload: expect.objectContaining({ substrate: 'terminal' }),
      }),
    );
  });

  it('renders no picker options when the bridge reports nothing reachable', () => {
    const panel = renderPanel({
      workspaceSlug: 'developer-workspace',
      workflowState: {
        runtime: { status: 'ready' },
        substrates: [],
      },
    });

    const picker = panel.querySelector('[data-workflow-substrate-picker="observe"]');
    expect(picker).toBeTruthy();
    // Only the placeholder remains - honest empty state, no fake choices.
    expect(picker.querySelectorAll('option')).toHaveLength(1);
  });
});
