/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FailureDistillerPanel } from './FailureDistillerPanel';

const gateway = {
  distillFailure: vi.fn(),
  runFailureCapsule: vi.fn(),
  explainFailureCapsule: vi.fn(),
  materializeFailureCapsule: vi.fn(),
  deleteFailureCapsule: vi.fn(),
  purgeExpiredFailureCapsules: vi.fn(),
  exportFailureCapsuleToVivarium: vi.fn(),
  promoteFailureCapsuleToVivarium: vi.fn(),
  getFailureDistillerMetrics: vi.fn(),
};

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(select, value);
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

vi.mock('@/hooks/useAnalyzerGateway', () => ({ useAnalyzerGateway: () => gateway }));

describe('FailureDistillerPanel', () => {
  let container;
  let root;

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
    vi.unstubAllGlobals();
  });

  it('does not offer mutable container tags to the isolation API', async () => {
    await act(async () => root.render(<FailureDistillerPanel />));
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'C:\\work\\app');
      setInputValue(inputs[1], 'pytest tests/failure.py');
      setInputValue(inputs[2], 'python:3.12-slim');
    });
    expect(container.textContent).toContain('A mutable tag cannot run');
    expect([...container.querySelectorAll('button')].find((button) => button.textContent.includes('Distill')).disabled).toBe(true);
    expect(gateway.distillFailure).not.toHaveBeenCalled();
  });

  it('distills a quoted command intact and exposes capsule operations', async () => {
    gateway.distillFailure.mockResolvedValue({ ok: true, status: 'distilled', capsuleId: 'capsule_test', workspacePath: '/tmp/capsule', baseline: { matching_failures: 2, attempts: 2 }, executions: 6, budget: { max_executions: 20, executions_performed_current_request: 6 }, isolation: { image: `registry.example/vectant@sha256:${'a'.repeat(64)}` }, reduction: { removed_units: 3, retained_units: 2, untested_count: 1, limiting_reason: 'max_executions' } });
    gateway.getFailureDistillerMetrics.mockResolvedValue({ ok: true, metrics: { accepted_capsules: 1, reduction_ratio: 0.6, validated_patches: 1 } });
    gateway.exportFailureCapsuleToVivarium.mockResolvedValue({ ok: true, status: 'vivarium_manifest_exported', scenarioId: 'distiller_capsule_test' });
    gateway.promoteFailureCapsuleToVivarium.mockResolvedValue({ ok: true, status: 'vivarium_promoted', promotionId: 'promotion_capsule_test' });
    gateway.deleteFailureCapsule.mockResolvedValue({ ok: true, status: 'deleted' });
    gateway.explainFailureCapsule.mockResolvedValue({ ok: true, evidence: [{ decision: 'removed' }] });
    gateway.purgeExpiredFailureCapsules.mockResolvedValue({ ok: true, status: 'purged', deleted: ['old_capsule'] });
    await act(async () => root.render(<FailureDistillerPanel />));
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'C:\\work\\app');
      setInputValue(inputs[1], 'pytest "tests/test invite.py"');
      setInputValue(inputs[2], `registry.example/vectant@sha256:${'a'.repeat(64)}`);
    });
    await act(async () => {
      setInputValue(inputs[4], 'src/InviteModal.tsx');
    });
    await act(async () => {
      setSelectValue(container.querySelectorAll('select')[0], 'hmr');
    });
    const textarea = container.querySelector('textarea');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '{"hmrEvents":["check","applied"]}');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(inputs[4].value).toBe('src/InviteModal.tsx');
    expect(container.querySelectorAll('select')[0].value).toBe('hmr');
    await act(async () => container.querySelector('button').click());
    expect(gateway.distillFailure).toHaveBeenCalledWith(expect.objectContaining({ command: 'pytest "tests/test invite.py"', workspaceRoot: 'C:\\work\\app', observation: { kind: 'hmr', filePath: 'src/InviteModal.tsx', hmrEvents: ['check', 'applied'] }, isolation: { mode: 'container', engine: 'docker', image: `registry.example/vectant@sha256:${'a'.repeat(64)}` } }));
    expect(container.textContent).toContain('capsule_test');
    expect(container.textContent).toContain('Baseline stability: 2/2');
    expect(container.textContent).toContain('1 units untested: max_executions');
    expect(container.textContent).toContain('Budget: 6/20 executions');
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => buttons.find((button) => button.textContent.includes('Explain source')).click());
    expect(gateway.explainFailureCapsule).toHaveBeenCalledWith('/tmp/capsule', 'src/InviteModal.tsx');
    await act(async () => buttons.find((button) => button.textContent.includes('Metrics')).click());
    expect(container.textContent).toContain('60% unit reduction');
    await act(async () => buttons.find((button) => button.textContent.includes('Vivarium')).click());
    expect(gateway.exportFailureCapsuleToVivarium).toHaveBeenCalledWith('/tmp/capsule');
    expect(container.textContent).toContain('distiller_capsule_test');
    await act(async () => buttons.find((button) => button.textContent.includes('Promote')).click());
    expect(gateway.promoteFailureCapsuleToVivarium).toHaveBeenCalledWith('/tmp/capsule');
    expect(container.textContent).toContain('promotion_capsule_test');
    await act(async () => buttons.find((button) => button.textContent.includes('Delete')).click());
    expect(gateway.deleteFailureCapsule).toHaveBeenCalledWith('/tmp/capsule');
    await act(async () => buttons.find((button) => button.textContent.includes('Purge expired')).click());
    expect(gateway.purgeExpiredFailureCapsules).toHaveBeenCalledWith('C:\\work\\app');
  });
});
