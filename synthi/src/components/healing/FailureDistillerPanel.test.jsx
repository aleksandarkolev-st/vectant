/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FailureDistillerPanel } from './FailureDistillerPanel';

const gateway = {
  distillFailure: vi.fn(),
  runFailureCapsule: vi.fn(),
  materializeFailureCapsule: vi.fn(),
  deleteFailureCapsule: vi.fn(),
  getFailureDistillerMetrics: vi.fn(),
};

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

  it('distills a quoted command intact and exposes capsule operations', async () => {
    gateway.distillFailure.mockResolvedValue({ ok: true, status: 'distilled', capsuleId: 'capsule_test', workspacePath: '/tmp/capsule', reduction: { removed_units: 3, retained_units: 2 } });
    gateway.getFailureDistillerMetrics.mockResolvedValue({ ok: true, metrics: { accepted_capsules: 1, reduction_ratio: 0.6, validated_patches: 1 } });
    gateway.deleteFailureCapsule.mockResolvedValue({ ok: true, status: 'deleted' });
    await act(async () => root.render(<FailureDistillerPanel />));
    const inputs = container.querySelectorAll('input');
    await act(async () => {
      setInputValue(inputs[0], 'C:\\work\\app');
      setInputValue(inputs[1], 'pytest "tests/test invite.py"');
    });
    await act(async () => container.querySelector('button').click());
    expect(gateway.distillFailure).toHaveBeenCalledWith(expect.objectContaining({ command: 'pytest "tests/test invite.py"', workspaceRoot: 'C:\\work\\app' }));
    expect(container.textContent).toContain('capsule_test');
    const buttons = [...container.querySelectorAll('button')];
    await act(async () => buttons.find((button) => button.textContent.includes('Metrics')).click());
    expect(container.textContent).toContain('60% unit reduction');
    await act(async () => buttons.find((button) => button.textContent.includes('Delete')).click());
    expect(gateway.deleteFailureCapsule).toHaveBeenCalledWith('/tmp/capsule');
  });
});
