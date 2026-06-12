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
      executable_graph_validation: { ok: true, issues: [] },
      case_law_runtime_bindings: {
        case_law_record_count: 1,
        approved_case_law_record_count: 1,
        bound_case_law_refs: ['CASE-RUNTIME-001'],
        bound_case_law_guardrail_ids: ['case_guard_CASE-RUNTIME-001'],
        graph_node_count: 6,
      },
      executable_graph: {
        schema_version: 'synthi.dojo.skillGraph.v1',
        graph_id: 'runtime-graph-save-invoice',
        skill_id: 'skill-save-invoice',
        skill_version: 'skill-save-invoice.v1',
        graph_version: 'skill-save-invoice.v1.graph',
        mode: 'production',
        created_at: '2026-06-12T00:00:00.000Z',
        nodes: [
          { node_id: 'trigger', kind: 'Trigger', label: 'MCP skill call', risk: 'safe', preconditions: [], postconditions: ['permission_requested'], guardrails: [], case_law_refs: [], assertions: [], evidence_policy: [], expiry_triggers: [], metadata: {} },
          { node_id: 'permission', kind: 'Permission', label: 'E3 license', risk: 'safe', preconditions: [], postconditions: ['license_allowed'], guardrails: [], case_law_refs: [], assertions: [], evidence_policy: ['license_scope_checked'], expiry_triggers: [], metadata: { license_id: 'license-001' } },
          { node_id: 'proof', kind: 'Proof', label: 'Validate proof capsule', risk: 'safe', preconditions: [], postconditions: ['proof_validated'], guardrails: [], case_law_refs: [], proof: { required: true, required_claims: ['workspace_verified'], required_guardrails: ['case_guard_CASE-RUNTIME-001'] }, assertions: [], evidence_policy: ['proof_validation_recorded'], expiry_triggers: [], metadata: {} },
          {
            node_id: 'action-submit',
            kind: 'Action',
            label: 'Submit invoice with runtime guardrail',
            risk: 'dangerous',
            action: 'submit_invoice',
            preconditions: ['stable_entity_identity == true'],
            postconditions: ['invoice state saved'],
            guardrails: [{ guardrail_id: 'case_guard_CASE-RUNTIME-001', predicate: 'stable_entity_identity == true', severity: 'block' }],
            case_law_refs: ['CASE-RUNTIME-001'],
            proof: { required: true, required_claims: ['workspace_verified'], required_guardrails: ['case_guard_CASE-RUNTIME-001'] },
            assertions: [{ assertion_id: 'assert-submit', description: 'Invoice state saved', required: true }],
            substrate_options: ['mcp'],
            evidence_policy: ['append_action_trace', 'append_postcondition_evidence'],
            expiry_triggers: [],
            metadata: { action_kind: 'click' },
          },
          { node_id: 'assert-submit', kind: 'Assertion', label: 'Invoice saved', risk: 'safe', preconditions: [], postconditions: ['invoice state saved'], guardrails: [], case_law_refs: [], assertions: [{ assertion_id: 'assert-submit', description: 'Invoice state saved', required: true }], evidence_policy: ['append_assertion_result'], expiry_triggers: [], metadata: {} },
          { node_id: 'expiry', kind: 'Expiry', label: 'Recertify on drift', risk: 'safe', preconditions: [], postconditions: [], guardrails: [], case_law_refs: [], assertions: [], evidence_policy: [], expiry_triggers: ['app_release_drift'], metadata: {} },
        ],
        edges: [
          { edge_id: 'edge-1', from_node_id: 'trigger', to_node_id: 'permission', condition: 'call_received == true', confidence: 1, observed_variants: [] },
          { edge_id: 'edge-2', from_node_id: 'permission', to_node_id: 'proof', condition: 'license_allowed == true', confidence: 1, observed_variants: [] },
          { edge_id: 'edge-3', from_node_id: 'proof', to_node_id: 'action-submit', condition: 'proof_valid == true', confidence: 1, observed_variants: [] },
          { edge_id: 'edge-4', from_node_id: 'action-submit', to_node_id: 'assert-submit', condition: 'postcondition_required == true', confidence: 0.92, observed_variants: [] },
          { edge_id: 'edge-5', from_node_id: 'assert-submit', to_node_id: 'expiry', condition: 'run_complete == true', confidence: 1, observed_variants: [] },
        ],
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
          { node_id: 'action-submit', kind: 'Action', label: 'Legacy submit invoice', risk: 'dangerous', substrate: 'mcp', inputs: ['proof'], outputs: ['assert-submit'], guardrail_refs: ['guard-client'], case_refs: ['CASE-001'], memory: { confidence: 0.91 }, metadata: { action_kind: 'click' } },
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
    const summary = buildGraphSummary();
    expect(summary.selectedSkill.graph.schemaVersion).toBe('synthi.dojo.skillGraph.v1');
    expect(summary.selectedSkill.graph.graphId).toBe('runtime-graph-save-invoice');
    expect(summary.selectedSkill.graph.caseLawRuntimeBindings.bound_case_law_guardrail_ids).toContain('case_guard_CASE-RUNTIME-001');

    const view = render(
      <SkillCortexGraph
        autoLoad={false}
        workspaceSlug="workspace-a"
        skillId="skill-save-invoice"
        initialSummary={summary}
      />,
    );

    expect(view.querySelector('[data-testid="skill-cortex-graph"]')?.textContent).toContain('MCP skill call');
    expect(view.querySelector('[data-testid="skill-cortex-graph"]')?.textContent).toContain('Submit invoice with runtime guardrail');
    expect(view.querySelector('[data-testid="skill-cortex-graph"]')?.textContent).not.toContain('Legacy submit invoice');
    expect(view.querySelector('[data-testid="cortex-node-inspector"]')?.textContent).toContain('MCP skill call');

    act(() => {
      view.querySelector('[data-testid="cortex-node-action-submit"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const inspectorText = view.querySelector('[data-testid="cortex-node-inspector"]')?.textContent || '';
    expect(inspectorText).toContain('Submit invoice with runtime guardrail');
    expect(inspectorText).toContain('Dangerous'.toLowerCase());
    expect(inspectorText).toContain('case_guard_CASE-RUNTIME-001');
    expect(inspectorText).toContain('CASE-RUNTIME-001');
  });

  it('renders an empty node inspector state', () => {
    const view = render(<CortexNodeInspector node={null} graph={{ nodes: [], edges: [] }} />);
    expect(view.querySelector('[data-testid="cortex-node-inspector-empty"]')?.textContent).toContain('Select a graph node');
  });
});
