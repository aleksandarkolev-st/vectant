import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TimeMachineDebugger from '../TimeMachineDebugger';
import GhostModePanel from '../GhostModePanel';
import { createEmptyDojoSummary, normalizeDojoWorkspaceSummary } from '@/services/dojoClient';

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

function render(ui) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return container;
}

function buildDebugSummary() {
  return normalizeDojoWorkspaceSummary({
    runtime: { status: 'ready' },
    dojo: {
      skillId: 'skill-save-invoice',
      label: 'Save invoice',
      status: 'licensed',
      time_machine_debugger: {
        schema_version: 'synthi.dojo.timeMachineDebugger.v1',
        debug_id: 'debug-001',
        question: 'What if stable entity identity changes?',
        baseline: {
          scenario_id: 'scenario-duplicate-client',
          mutation_kind: 'duplicate_entity',
          status: 'failed',
          finding: 'Duplicate display name was selected.',
        },
        counterfactual: {
          changed_variable: 'stable_entity_identity',
          expected_status_after_change: 'blocked',
          causal_finding: 'Changing stable identity invalidates the current license branch.',
          license_impact: 'Keep the skill at E2 until recertification passes.',
        },
        guardrails: [
          { guardrail_id: 'guard-stable-id', title: 'Stable ID required', rule: 'client_id_verified == true', severity: 'critical' },
        ],
        replay_plan: [
          { step: 'replay_static_trace', simulator_tier: 0, expected_evidence: ['workflow:save-invoice'] },
          { step: 'rerun_checkride_branch', simulator_tier: 2, expected_evidence: ['checkride:save-invoice'] },
        ],
      },
      ghost_run: {
        run_id: 'ghost-001',
        status: 'mismatch',
        would_execute: false,
        production_mutations_executed: false,
        license_status: 'blocked',
        shadow_evidence_id: 'ghost-evidence-001',
        evidence_refs: ['skill:dojo-save-invoice', 'ghost:ghost-001', 'guardrail:guard-stable-id'],
        entrustment_impact: {
          upgrade_allowed: false,
          recommended_entrustment: 'EX',
          reason: 'Ghost Mode mismatch prevents entrustment upgrade until the planned action is recertified.',
        },
        observed_human_action: { action: 'click', label: 'Save invoice', selector: 'button[name=Save]' },
        agent_planned_action: { action: 'click', label: 'Submit invoice', selector: 'button[name=Submit]' },
        guardrails_triggered: ['guard-stable-id'],
        explanation: 'Ghost mode found a mismatch and did not execute production mutations.',
      },
    },
  }, 'workspace-a');
}

describe('TimeMachineDebugger', () => {
  it('renders an empty debug state', () => {
    const view = render(
      <TimeMachineDebugger
        autoLoad={false}
        workspaceSlug="workspace-a"
        initialSummary={createEmptyDojoSummary('workspace-a')}
      />,
    );

    expect(view.querySelector('[data-testid="dojo-time-machine"]')?.textContent).toContain('Time Machine Debugger');
    expect(view.querySelector('[data-testid="time-machine-empty"]')?.textContent).toContain('No debug run yet');
  });

  it('renders counterfactual branch, replay plan, guardrails, and Ghost Mode diff', () => {
    const view = render(
      <TimeMachineDebugger
        autoLoad={false}
        workspaceSlug="workspace-a"
        initialSummary={buildDebugSummary()}
      />,
    );

    const text = view.querySelector('[data-testid="dojo-time-machine"]')?.textContent || '';
    expect(text).toContain('What if stable entity identity changes?');
    expect(text).toContain('Duplicate display name was selected.');
    expect(text).toContain('stable_entity_identity');
    expect(text).toContain('Keep the skill at E2');
    expect(text).toContain('guard-stable-id');
    expect(text).toContain('replay_static_trace');
    expect(text).toContain('Ghost mode found a mismatch');
    expect(text).toContain('Save invoice');
    expect(text).toContain('Submit invoice');
    expect(text).toContain('Shadow only');
    expect(text).toContain('ghost-evidence-001');
    expect(text).toContain('Ghost Mode mismatch prevents entrustment upgrade');
  });

  it('renders an empty Ghost Mode panel state', () => {
    const view = render(<GhostModePanel ghostRun={null} />);
    expect(view.querySelector('[data-testid="ghost-mode-empty"]')?.textContent).toContain('No shadow comparison');
  });

  it('loads summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(buildDebugSummary());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<TimeMachineDebugger workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('What if stable entity identity changes?');
  });
});
