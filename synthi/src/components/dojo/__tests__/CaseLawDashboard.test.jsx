import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CaseLawDashboard from '../CaseLawDashboard';
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

function renderDashboard(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<CaseLawDashboard autoLoad={false} {...props} />);
  });
  return container;
}

function buildCaseLawSummary() {
  return normalizeDojoWorkspaceSummary({
    runtime: { status: 'ready' },
    dojo: {
      skillId: 'skill-save-invoice',
      label: 'Save invoice',
      status: 'licensed',
      published: true,
      case_law: [
        {
          case_id: 'CASE-001',
          title: 'Duplicate client stable ID',
          date: '2026-06-11',
          source_skill_id: 'skill-save-invoice',
          source_run_id: 'checkride-001',
          finding: 'Duplicate display names can select the wrong client.',
          impact: 'Could cause a wrong production action.',
          rule_created: 'Require stable client ID before submit.',
          applies_to: ['workflow', 'click'],
          binding_scope: 'workspace',
          status: 'binding',
          evidence_refs: ['evidence-001'],
        },
        {
          case_id: 'CASE-002',
          title: 'Fake success toast',
          finding: 'UI success can appear while durable state fails.',
          impact: 'Could produce false success.',
          rule_created: 'Require durable state evidence before success.',
          applies_to: ['workflow'],
          binding_scope: 'skill',
          status: 'proposed',
          evidence_refs: ['evidence-002'],
        },
      ],
      guardrails: [
        {
          guardrail_id: 'guard-stable-id',
          title: 'Stable ID required',
          rule: 'client_id_verified == true',
          blocks_actions: ['run_workflow'],
          source_case_id: 'CASE-001',
          severity: 'critical',
        },
      ],
      antibodies: [
        {
          antibody_id: 'antibody-stable-id',
          case_id: 'CASE-001',
          guardrail_id: 'guard-stable-id',
          trigger: 'duplicate_display_name_count > 0',
          response: 'Ask for stable entity identity before action.',
          applies_to: ['workflow'],
          binding_scope: 'organization',
          evidence_refs: ['evidence-001'],
          created_at: '2026-06-11T00:00:00.000Z',
        },
      ],
    },
  }, 'workspace-a');
}

describe('CaseLawDashboard', () => {
  it('renders an empty case-law state', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="dojo-case-law-dashboard"]')?.textContent).toContain('Case Law');
    expect(view.querySelector('[data-testid="dojo-case-law-empty"]')?.textContent).toContain('No case law yet');
  });

  it('renders cases, guardrail provenance, and antibodies', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: buildCaseLawSummary(),
    });

    expect(view.querySelector('[data-testid="case-law-registry"]')?.textContent).toContain('CASE-001');
    expect(view.querySelector('[data-testid="case-law-registry"]')?.textContent).toContain('Duplicate display names');
    expect(view.querySelector('[data-testid="case-law-registry"]')?.textContent).toContain('Fake success toast');
    expect(view.querySelector('[data-testid="guardrail-provenance"]')?.textContent).toContain('client_id_verified == true');
    expect(view.querySelector('[data-testid="guardrail-provenance"]')?.textContent).toContain('CASE-001');
    expect(view.querySelector('[data-testid="antibody-registry"]')?.textContent).toContain('antibody-stable-id');
    expect(view.querySelector('[data-testid="antibody-registry"]')?.textContent).toContain('Ask for stable entity identity');
    expect(view.textContent).toContain('binding');
    expect(view.textContent).toContain('proposed');
  });

  it('loads case-law summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(buildCaseLawSummary());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<CaseLawDashboard workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('CASE-002');
  });
});
