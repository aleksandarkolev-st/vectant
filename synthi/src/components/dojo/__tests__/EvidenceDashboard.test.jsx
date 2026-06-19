import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EvidenceDashboard from '../EvidenceDashboard';
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
    root.render(<EvidenceDashboard autoLoad={false} {...props} />);
  });
  return container;
}

function buildEvidenceSummary() {
  return normalizeDojoWorkspaceSummary({
    runtime: { status: 'ready' },
    dojo: {
      skillId: 'skill-save-invoice',
      label: 'Save invoice',
      status: 'licensed',
      published: true,
      proofRequired: true,
      evidence_ledger: {
        schema_version: 'synthi.dojo.evidenceLedger.v1',
        ledger_id: 'ledger-001',
        skill_id: 'skill-save-invoice',
        workspace_id: 'workspace-a',
        storage_model: {
          live_state_store: 'postgres_evidence_store',
          repo_export_policy: 'metadata_and_redacted_references_only',
          production_data_allowed_in_organoid: false,
          secrets_allowed_in_repo: false,
        },
        retention_policy: {
          evidence_refs_only: true,
          screenshots_redacted_by_default: true,
          recertify_after_days: 30,
        },
        records: [
          {
            record_id: 'evidence-001',
            kind: 'trace',
            ref: 'workflow:save-invoice',
            redaction: 'metadata_only',
            hash: '1111111111111111111111111111111111111111111111111111111111111111',
            previous_hash: null,
          },
          {
            record_id: 'evidence-002',
            kind: 'checkride',
            ref: 'checkride:save-invoice',
            redaction: 'redacted',
            hash: '2222222222222222222222222222222222222222222222222222222222222222',
            previous_hash: '1111111111111111111111111111111111111111111111111111111111111111',
            claim_ids: ['checkride_passed', 'guardrails_active'],
          },
        ],
        head_hash: '2222222222222222222222222222222222222222222222222222222222222222',
      },
      redacted_evidence_export_manifest: {
        manifest_id: 'redacted-export-001',
        artifacts: [
          {
            artifact_id: 'artifact-checkride',
            artifact_kind: 'document_text',
            artifact_uri: 'dojo-artifact://save-invoice/checkride.report.md',
            redaction_id: 'redaction-checkride',
            redaction_count: 3,
            redaction_manifest_sha256: '3333333333333333333333333333333333333333333333333333333333333333',
            rules_applied: ['email', 'token'],
            source_refs: ['checkride:save-invoice'],
          },
        ],
        excluded: ['raw_screenshots', 'secrets'],
      },
      evidence_claims: [
        { claim: 'checkride_passed', status: 'verified', evidence_refs: ['evidence-002'] },
        { claim: 'workspace_verified', status: 'verified', evidence_record_ids: ['evidence-001'] },
      ],
    },
  }, 'workspace-a');
}

describe('EvidenceDashboard', () => {
  it('renders an empty evidence state', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="dojo-evidence-dashboard"]')?.textContent).toContain('Evidence Custody');
    expect(view.querySelector('[data-testid="dojo-evidence-empty"]')?.textContent).toContain('No evidence records yet');
  });

  it('renders ledger chain, claims, custody policy, and redacted export', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: buildEvidenceSummary(),
    });

    expect(view.querySelector('[data-testid="evidence-ledger-chain"]')?.textContent).toContain('ledger-001');
    expect(view.querySelector('[data-testid="evidence-ledger-chain"]')?.textContent).toContain('evidence-002');
    expect(view.querySelector('[data-testid="evidence-custody-policy"]')?.textContent).toContain('postgres_evidence_store');
    expect(view.querySelector('[data-testid="evidence-claims-panel"]')?.textContent).toContain('checkride_passed');
    expect(view.querySelector('[data-testid="redacted-evidence-export"]')?.textContent).toContain('redacted-export-001');
    expect(view.querySelector('[data-testid="redacted-evidence-export"]')?.textContent).toContain('artifact-checkride');
    expect(view.textContent).toContain('raw_screenshots');
  });

  it('loads evidence summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(buildEvidenceSummary());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<EvidenceDashboard workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('evidence-002');
  });
});
