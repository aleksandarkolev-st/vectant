import { describe, expect, it } from 'vitest';

import {
  SYNTHI_AGENTS_SECTION_END,
  SYNTHI_AGENTS_SECTION_START,
  buildAgentWorkflowHandoffFiles,
  mergeWorkflowIndex,
  safeWorkflowDirectoryName,
  upsertAgentsWorkflowSection,
  workflowParameterEnvName,
} from '../agentWorkflowHandoff';

describe('agentWorkflowHandoff', () => {
  it('builds stable repo-discoverable workflow files without preview port literals', () => {
    const generated = {
      workflow_id: 'wf_demo_123',
      code: [
        "import { test } from '@playwright/test';",
        'test("workflow", async ({ page }) => {',
        '  const baseUrl = process.env.PLAYWRIGHT_BASE_URL;',
        '  await page.goto(baseUrl);',
        '});',
      ].join('\n'),
    };
    const manifest = {
      kind: 'privateMcpToolManifest',
      workflow_id: 'wf_demo_123',
      title: 'Save runbook',
      status: 'manualOnly',
      default_run_mode: 'confirmBeforeCommit',
      parameters: [{ name: 'RUNBOOK_NOTE', label: 'Runbook note', value_shape: 'text', required: true }],
      mutation: { requires_ci_isolation: true },
      source_identity: { status: 'complete' },
    };

    const { entry, files } = buildAgentWorkflowHandoffFiles({ generated, manifest });
    const byPath = new Map(files.map((file) => [file.path, file.content]));

    expect(entry.script_path).toBe('.synthi/workflows/wf_demo_123/workflow.spec.mjs');
    expect(entry.parameters[0].env_name).toBe('RUNBOOK_NOTE');
    expect(byPath.has('.synthi/workflows/index.json')).toBe(true);
    expect(byPath.has('AGENTS.md')).toBe(true);
    expect(byPath.get('AGENTS.md')).toContain('inspect `.synthi/workflows/index.json`');
    expect(byPath.get('.synthi/workflows/wf_demo_123/README.md')).toContain('`RUNBOOK_NOTE`');
    expect(JSON.stringify(files)).toContain('PLAYWRIGHT_BASE_URL');
    expect(JSON.stringify(files)).not.toMatch(/\/port\/\d+|localhost:1234\/port\/\d+/);
  });

  it('merges workflow indexes without dropping unrelated workflow entries', () => {
    const merged = mergeWorkflowIndex(
      JSON.stringify({
        kind: 'synthi_browser_workflow_index',
        workflows: [
          { workflow_id: 'wf_existing', script_path: '.synthi/workflows/wf_existing/workflow.spec.mjs' },
          { workflow_id: 'wf_replace', script_path: 'old.spec.mjs' },
        ],
      }),
      {
        workflow_id: 'wf_replace',
        title: 'Replacement',
        generated_at: '2026-06-08T18:00:00.000Z',
        script_path: '.synthi/workflows/wf_replace/workflow.spec.mjs',
      },
    );

    expect(merged.workflows.map((workflow) => workflow.workflow_id)).toEqual(['wf_replace', 'wf_existing']);
    expect(merged.workflows[0].script_path).toBe('.synthi/workflows/wf_replace/workflow.spec.mjs');
  });

  it('upserts only the managed AGENTS section', () => {
    const first = upsertAgentsWorkflowSection('# Existing Instructions\n\nKeep this.');
    const second = upsertAgentsWorkflowSection(first.replace('reuse an existing workflow', 'reuse generated workflow'));

    expect(first).toContain('# Existing Instructions');
    expect(first).toContain('Keep this.');
    expect(second).toContain('# Existing Instructions');
    expect(second).toContain('Keep this.');
    expect((second.match(new RegExp(SYNTHI_AGENTS_SECTION_START, 'g')) || []).length).toBe(1);
    expect((second.match(new RegExp(SYNTHI_AGENTS_SECTION_END, 'g')) || []).length).toBe(1);
    expect(second).toContain('reuse an existing workflow');
  });

  it('normalizes unsafe workflow ids into bounded directory names', () => {
    expect(safeWorkflowDirectoryName(' Save runbook: /prod? x '.repeat(8))).toMatch(/^save-runbook-prod-x/);
    expect(safeWorkflowDirectoryName('../..')).toBe('workflow');
    expect(workflowParameterEnvName('risk-threshold value')).toBe('RISK_THRESHOLD_VALUE');
  });
});
