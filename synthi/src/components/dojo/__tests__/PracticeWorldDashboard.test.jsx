import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PracticeWorldDashboard from '../PracticeWorldDashboard';
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

function renderPractice(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<PracticeWorldDashboard autoLoad={false} {...props} />);
  });
  return container;
}

function buildPracticeSummary() {
  return normalizeDojoWorkspaceSummary({
    runtime: { status: 'ready' },
    dojo: {
      skillId: 'skill-save-invoice',
      label: 'Save invoice',
      status: 'licensed',
      published: true,
      entrustmentLevel: 'E3',
      readinessLevel: 7,
      scenarioCount: 2,
      proofRequired: true,
      checkride: {
        coverageScore: 0.75,
        criticalFailures: 1,
        blockedScenarios: 1,
      },
      scenarios: [
        {
          scenario_id: 'scenario-duplicate-client',
          title: 'Duplicate client names',
          layer: 'risk',
          simulator_tier: 'dom_mock',
          mutation_kind: 'duplicate_entity',
          expected_behavior: 'ask_human',
          risk_tags: ['identity', 'stable-id'],
        },
        {
          scenario_id: 'scenario-fake-success',
          title: 'Fake success toast',
          layer: 'skill',
          simulator_tier: 'api_mock',
          mutation_kind: 'fake_success',
          expected_behavior: 'block_false_success',
          risk_tags: ['postcondition'],
        },
      ],
      workspaceOrganoid: {
        data_policy: { synthetic_data_only: true },
        fixture_seed: 'fixture-seed-001',
        tissues: {
          ui: {},
          data: {},
          api: {},
          identity: {},
        },
      },
      vivariumRun: {
        run_id: 'scenario-run-001',
        scenario_id: 'scenario-duplicate-client',
        mutation_kind: 'duplicate_entity',
        status: 'blocked',
        finding: 'Stable ID guardrail stopped duplicate client selection.',
        evidence_refs: ['dojo-graph://scenario-run-001/action', 'dojo-oracle://scenario-run-001/oracle'],
      },
      windTunnel: {
        run_count: 2,
        summary: {
          passed: 1,
          failed: 0,
          blocked: 1,
          stop_reason: 'budget_complete',
        },
        runs: [
          {
            run_id: 'wind-run-001',
            scenario_id: 'scenario-duplicate-client',
            mode: 'vivarium',
            simulator_tier: 'dom_mock',
            status: 'blocked',
            mutation_kind: 'duplicate_entity',
            finding: 'Guardrail triggered.',
            evidence_refs: ['dojo-graph://wind-run-001/action'],
          },
          {
            run_id: 'wind-run-002',
            scenario_id: 'scenario-fake-success',
            mode: 'vivarium',
            simulator_tier: 'api_mock',
            status: 'passed',
            mutation_kind: 'fake_success',
            evidence_refs: ['dojo-oracle://wind-run-002/oracle'],
          },
        ],
      },
    },
  }, 'workspace-a');
}

describe('PracticeWorldDashboard', () => {
  it('renders an empty practice state', () => {
    const view = renderPractice({
      workspaceSlug: 'workspace-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="dojo-practice-world"]')?.textContent).toContain('Practice World');
    expect(view.querySelector('[data-testid="dojo-practice-empty"]')?.textContent).toContain('No practice world yet');
  });

  it('renders scenarios, Wind Tunnel runs, and synthetic fixture proof', () => {
    const view = renderPractice({
      workspaceSlug: 'workspace-a',
      initialSummary: buildPracticeSummary(),
    });

    expect(view.querySelector('[data-testid="dojo-scenario-list"]')?.textContent).toContain('Duplicate client names');
    expect(view.querySelector('[data-testid="dojo-scenario-list"]')?.textContent).toContain('Fake success toast');
    expect(view.querySelector('[data-testid="dojo-wind-tunnel-matrix"]')?.textContent).toContain('wind-run-001');
    expect(view.querySelector('[data-testid="dojo-wind-tunnel-matrix"]')?.textContent).toContain('scenario-fake-success');
    expect(view.querySelector('[data-testid="dojo-practice-latest-evidence"]')?.textContent).toContain('Stable ID guardrail');
    expect(view.textContent).toContain('fixture-seed-001');
    expect(view.textContent).toContain('synthetic-only');
    expect(view.textContent).toContain('75% coverage');
  });

  it('loads summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(buildPracticeSummary());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<PracticeWorldDashboard workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('Duplicate client names');
  });
});
