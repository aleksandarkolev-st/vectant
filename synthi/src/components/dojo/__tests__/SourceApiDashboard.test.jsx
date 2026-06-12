import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SourceApiDashboard from '../SourceApiDashboard';
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
    root.render(<SourceApiDashboard autoLoad={false} {...props} />);
  });
  return container;
}

function buildSourceSummary() {
  return normalizeDojoWorkspaceSummary({
    runtime: { status: 'ready' },
    dojo: {
      skillId: 'skill-save-invoice',
      label: 'Save invoice',
      status: 'licensed',
      published: true,
      proofRequired: true,
      sourceAffordancePrPlan: {
        schema_version: 'synthi.dojo.sourceAffordancePrPlan.v1',
        plan_id: 'source-pr-001',
        readiness: 'ready_for_review',
        patch_count: 2,
        files: [
          {
            file_path: 'src/app/invoices/InvoiceForm.jsx',
            source_anchor_id: 'anchor-save-invoice',
            patches: [
              {
                patch_id: 'patch-save-invoice',
                action_id: 'ui_action_save',
                intent: 'Expose Save invoice as a stable agent affordance.',
                suggested_attribute: 'data-synthi-action="save-invoice"',
                risk_annotation: 'data-synthi-risk="mutation"',
                success_hook: 'data-synthi-success="invoice-saved"',
                proof_hook: 'data-synthi-proof-required="true"',
                review_required: true,
              },
            ],
          },
        ],
        generated_tests: [
          { path: '.synthi/dojo/playwright/save-invoice.spec.ts', purpose: 'Verify affordance reachability.' },
        ],
        review_checklist: ['Confirm every risky action has a proof hook.'],
      },
      agent_ready_ui_contract: {
        contract_id: 'ui-contract-001',
        target_app_origin: 'https://billing.example.test',
        actions: [
          {
            action_id: 'ui_action_save',
            label: 'Save invoice',
            source_step_id: 'step-save',
            source_anchor_id: 'anchor-save-invoice',
            stable_locator: '[data-synthi-action="save-invoice"]',
            allowed_substrates: ['dom', 'source', 'api'],
            success_condition: 'invoice draft exists',
            risk_tags: ['mutation', 'billing'],
            proof_claims: ['workspace_verified'],
          },
        ],
      },
      skillGraph: {
        graph_id: 'graph-001',
        nodes: [
          {
            node_id: 'action-save',
            kind: 'Action',
            label: 'Save invoice',
            substrate: 'api',
            proof: { required: true },
            metadata: {
              source_anchor_id: 'anchor-save-invoice',
              api_candidate_id: 'api-candidate-save-invoice',
            },
          },
        ],
        edges: [],
      },
      api_candidates: [
        {
          candidate_id: 'api-candidate-save-invoice',
          method: 'POST',
          path: '/api/invoices',
          mutation_class: 'create',
          auth_scope: 'invoices:write',
          idempotency_key_location: 'header',
          rollback_strategy: 'delete_draft',
          postcondition: 'invoice draft exists',
          review_status: 'approved',
          proof_claim_mapping: { workspace_verified: 'workspace_id' },
          inferred_from: ['network:POST:/api/invoices'],
          review: { ok_to_promote: true, issues: [] },
        },
      ],
      generated_tools: [
        {
          tool_name: 'synthi_api_save_invoice',
          tool_version: '1.0.0',
          candidate_id: 'api-candidate-save-invoice',
          status: 'ready_for_review',
          proof_required: true,
          schema_digest: 'sha256:tool-schema',
        },
      ],
    },
  }, 'workspace-a');
}

describe('SourceApiDashboard', () => {
  it('renders an empty source/API state', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="dojo-source-api"]')?.textContent).toContain('Source/API Graduation');
    expect(view.querySelector('[data-testid="dojo-source-empty"]')?.textContent).toContain('No source/API artifacts yet');
  });

  it('renders UI contract, source PR plan, substrate ladder, API candidate, and generated tool', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: buildSourceSummary(),
    });

    expect(view.querySelector('[data-testid="agent-ready-ui-contract"]')?.textContent).toContain('ui-contract-001');
    expect(view.querySelector('[data-testid="agent-ready-ui-contract"]')?.textContent).toContain('[data-synthi-action="save-invoice"]');
    expect(view.querySelector('[data-testid="source-affordance-pr-plan"]')?.textContent).toContain('source-pr-001');
    expect(view.querySelector('[data-testid="source-affordance-pr-plan"]')?.textContent).toContain('src/app/invoices/InvoiceForm.jsx');
    expect(view.querySelector('[data-testid="substrate-ladder-view"]')?.textContent).toContain('api-candidate-save-invoice');
    expect(view.querySelector('[data-testid="api-candidate-review"]')?.textContent).toContain('/api/invoices');
    expect(view.querySelector('[data-testid="generated-tool-review"]')?.textContent).toContain('synthi_api_save_invoice');
    expect(view.textContent).toContain('ready_for_review');
  });

  it('loads source/API summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(buildSourceSummary());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<SourceApiDashboard workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('api-candidate-save-invoice');
  });
});
