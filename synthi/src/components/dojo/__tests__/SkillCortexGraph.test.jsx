import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import SkillCortexGraph from '../SkillCortexGraph';
import CortexNodeInspector from '../CortexNodeInspector';
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

function buildGraphSummary() {
  return normalizeDojoWorkspaceSummary({
    runtime: { status: 'ready' },
    dojo: {
      skillId: 'skill-save-invoice',
      label: 'Save invoice',
      status: 'licensed',
      published: true,
      entrustmentLevel: 'E3',
      readinessLevel: 7,
      proofRequired: true,
      license: {
        allowedActions: ['Create draft invoice'],
        blockedActions: ['Delete invoice'],
        requiredProofClaims: ['workspace_verified'],
      },
      skillCortex: {
        schema_version: 'synthi.dojo.skillCortex.v1',
        workflow_graph_id: 'graph-save-invoice',
        skill_id: 'skill-save-invoice',
        mode: 'production',
        validation: { ok: true, issues: [] },
        nodes: [
          { node_id: 'trigger', kind: 'Trigger', label: 'MCP skill call', inputs: [], outputs: ['permission'], guardrail_refs: [], case_refs: [], memory: {}, metadata: {} },
          { node_id: 'permission', kind: 'Permission', label: 'E3 license', inputs: ['trigger'], outputs: ['proof'], guardrail_refs: ['guard-client'], case_refs: [], memory: {}, metadata: { license_id: 'license-001' } },
          { node_id: 'proof', kind: 'Proof', label: 'Validate proof capsule', inputs: ['permission'], outputs: ['action-submit'], guardrail_refs: ['guard-client'], case_refs: [], memory: {}, metadata: { evidence_claims: ['workspace_verified'] } },
          { node_id: 'action-submit', kind: 'Action', label: 'Submit invoice', risk: 'dangerous', substrate: 'mcp', inputs: ['proof'], outputs: ['assert-submit'], guardrail_refs: ['guard-client'], case_refs: ['CASE-001'], memory: { confidence: 0.91 }, metadata: { action_kind: 'click' } },
          { node_id: 'assert-submit', kind: 'Assertion', label: 'Invoice saved', inputs: ['action-submit'], outputs: ['expiry'], guardrail_refs: [], case_refs: [], memory: {}, metadata: { expected_effects: ['invoice state saved'] } },
          { node_id: 'expiry', kind: 'Expiry', label: 'Recertify on drift', inputs: ['assert-submit'], outputs: [], guardrail_refs: [], case_refs: [], memory: {}, metadata: { expires_on: ['app_release_drift'] } },
        ],
        edges: [
          { edge_id: 'edge-1', from_node_id: 'trigger', to_node_id: 'permission', condition: 'call_received', confidence: 1 },
          { edge_id: 'edge-2', from_node_id: 'permission', to_node_id: 'proof', condition: 'license_allowed', confidence: 1 },
          { edge_id: 'edge-3', from_node_id: 'proof', to_node_id: 'action-submit', condition: 'proof_valid', confidence: 1 },
          { edge_id: 'edge-4', from_node_id: 'action-submit', to_node_id: 'assert-submit', condition: 'postcondition_required', confidence: 0.92 },
          { edge_id: 'edge-5', from_node_id: 'assert-submit', to_node_id: 'expiry', condition: 'run_complete', confidence: 1 },
        ],
      },
    },
  }, 'workspace-a');
}

describe('SkillCortexGraph', () => {
  it('renders an empty graph state', () => {
    const view = render(
      <SkillCortexGraph
        autoLoad={false}
        workspaceSlug="workspace-a"
        skillId="skill-a"
        initialSummary={createEmptyDojoSummary('workspace-a')}
      />,
    );

    expect(view.querySelector('[data-testid="skill-cortex-view"]')?.textContent).toContain('Skill Cortex');
    expect(view.querySelector('[data-testid="skill-cortex-empty"]')?.textContent).toContain('Cortex unavailable');
  });

  it('renders graph nodes and updates the inspector on selection', () => {
    const view = render(
      <SkillCortexGraph
        autoLoad={false}
        workspaceSlug="workspace-a"
        skillId="skill-save-invoice"
        initialSummary={buildGraphSummary()}
      />,
    );

    expect(view.querySelector('[data-testid="skill-cortex-graph"]')?.textContent).toContain('MCP skill call');
    expect(view.querySelector('[data-testid="skill-cortex-graph"]')?.textContent).toContain('Submit invoice');
    expect(view.querySelector('[data-testid="cortex-node-inspector"]')?.textContent).toContain('MCP skill call');

    act(() => {
      view.querySelector('[data-testid="cortex-node-action-submit"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const inspectorText = view.querySelector('[data-testid="cortex-node-inspector"]')?.textContent || '';
    expect(inspectorText).toContain('Submit invoice');
    expect(inspectorText).toContain('Dangerous'.toLowerCase());
    expect(inspectorText).toContain('guard-client');
    expect(inspectorText).toContain('CASE-001');
  });

  it('renders an empty node inspector state', () => {
    const view = render(<CortexNodeInspector node={null} graph={{ nodes: [], edges: [] }} />);
    expect(view.querySelector('[data-testid="cortex-node-inspector-empty"]')?.textContent).toContain('Select a graph node');
  });
});
