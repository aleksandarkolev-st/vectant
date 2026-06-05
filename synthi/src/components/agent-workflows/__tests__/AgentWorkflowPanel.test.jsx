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

describe('AgentWorkflowPanel view model', () => {
  it('starts from the hosted runtime attach path without local dev harness assumptions', () => {
    const model = createDefaultWorkflowViewModel();
    const summary = deriveWorkflowPanelSummary(model);

    expect(WORKFLOW_ACTIONS.COMPILE_CONTRACT).toBe('synthi_browser_compile_workflow');
    expect(WORKFLOW_ACTIONS.PREFIX_VALIDATE).toBe('synthi_safety_run_prefix_validation');
    expect(WORKFLOW_ACTIONS.GENERATE_SCRIPT).toBe('synthi_browser_generate_script');
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

    const teachButton = [...panel.querySelectorAll('button')].find((button) => button.textContent.includes('Teach'));
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
});
