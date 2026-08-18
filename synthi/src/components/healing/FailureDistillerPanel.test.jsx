/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FailureDistillerPanel } from './FailureDistillerPanel';

const gateway = {
  distillFailure: vi.fn(), runFailureCapsule: vi.fn(), explainFailureCapsule: vi.fn(), materializeFailureCapsule: vi.fn(),
  validateFailureCapsulePatch: vi.fn(), deleteFailureCapsule: vi.fn(), purgeExpiredFailureCapsules: vi.fn(),
  exportFailureCapsuleToVivarium: vi.fn(), promoteFailureCapsuleToVivarium: vi.fn(), getFailureDistillerMetrics: vi.fn(),
};

function setValue(element, value) {
  const prototype = element instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select, value) {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

vi.mock('@/hooks/useAnalyzerGateway', () => ({ useAnalyzerGateway: () => gateway }));

describe('FailureDistillerPanel', () => {
  let container;
  let root;
  const props = { workspaceSlug: 'workspace-safe', workspaceRef: 'workspace-safe/user-safe', activeFile: 'src/InviteModal.tsx' };

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.confirm = vi.fn(() => true);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('binds to the active workspace and blocks mutable images', async () => {
    await act(async () => root.render(<FailureDistillerPanel {...props} />));
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setValue(inputs[0], 'pytest tests/failure.py');
      setValue(inputs[1], 'python:3.12-slim');
    });
    expect(container.textContent).toContain('Workspace: workspace-safe');
    expect(container.textContent).toContain('Mutable image tags cannot run');
    expect([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Distill')).disabled).toBe(true);
    expect(gateway.distillFailure).not.toHaveBeenCalled();
  });

  it('distills with the opaque workspace ref and exposes lifecycle controls', async () => {
    gateway.distillFailure.mockResolvedValue({ ok: true, status: 'distilled', capsuleId: 'capsule_test', workspacePath: '/tmp/capsule', baseline: { matching_failures: 2, attempts: 2 }, budget: { max_executions: 20, executions_performed_current_request: 6 }, reduction: { removed_units: 3, retained_units: 2, untested_count: 1, limiting_reason: 'max_executions' } });
    gateway.getFailureDistillerMetrics.mockResolvedValue({ ok: true, metrics: { accepted_capsules: 1, reduction_ratio: 0.6, validated_patches: 1 } });
    gateway.explainFailureCapsule.mockResolvedValue({ ok: true, evidence: [{ decision: 'removed' }] });
    gateway.exportFailureCapsuleToVivarium.mockResolvedValue({ ok: true, status: 'vivarium_manifest_exported' });
    gateway.promoteFailureCapsuleToVivarium.mockResolvedValue({ ok: true, status: 'vivarium_promoted' });
    gateway.deleteFailureCapsule.mockResolvedValue({ ok: true, status: 'deleted' });
    gateway.purgeExpiredFailureCapsules.mockResolvedValue({ ok: true, status: 'purged' });
    await act(async () => root.render(<FailureDistillerPanel {...props} />));
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setValue(inputs[0], 'pytest "tests/test invite.py"');
      setValue(inputs[1], `registry.example/vectant@sha256:${'a'.repeat(64)}`);
      setValue(inputs[3], 'src/InviteModal.tsx');
      setSelectValue(container.querySelectorAll('select')[0], 'hmr');
    });
    await act(async () => setValue(container.querySelector('textarea'), '{"hmrEvents":["check","applied"]}'));
    await act(async () => [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Distill')).click());
    expect(gateway.distillFailure).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRef: 'workspace-safe/user-safe', command: 'pytest "tests/test invite.py"',
      observation: { kind: 'hmr', filePath: 'src/InviteModal.tsx', hmrEvents: ['check', 'applied'] },
    }));
    expect(container.textContent).toContain('capsule_test');
    expect(container.textContent).toContain('Baseline stability: 2/2');
    expect(container.textContent).toContain('1 units untested: max_executions');
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => buttons.find((button) => button.textContent.includes('Explain')).click());
    expect(gateway.explainFailureCapsule).toHaveBeenCalledWith('/tmp/capsule', 'src/InviteModal.tsx');
    await act(async () => buttons.find((button) => button.textContent.includes('Metrics')).click());
    expect(container.textContent).toContain('60% unit reduction');
    await act(async () => buttons.find((button) => button.textContent.includes('Export')).click());
    expect(gateway.exportFailureCapsuleToVivarium).toHaveBeenCalledWith('/tmp/capsule');
    await act(async () => buttons.find((button) => button.textContent.includes('Promote')).click());
    expect(gateway.promoteFailureCapsuleToVivarium).toHaveBeenCalledWith('/tmp/capsule');
    await act(async () => buttons.find((button) => button.textContent.includes('Purge expired')).click());
    expect(gateway.purgeExpiredFailureCapsules).toHaveBeenCalledWith('workspace-safe/user-safe');
  });
});
