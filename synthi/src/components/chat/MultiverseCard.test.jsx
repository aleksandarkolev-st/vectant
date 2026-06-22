import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiverseCard } from './MultiverseCard.jsx';
import { useShadowVerify } from './hooks/useShadowVerify.js';

vi.mock('./hooks/useShadowVerify.js', () => ({
  useShadowVerify: vi.fn(),
}));

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
  vi.clearAllMocks();
});

function renderWithVerify(verify) {
  useShadowVerify.mockReturnValue({
    jobId: 'job-1',
    tier: 'standard',
    universes: {},
    learnedLines: [],
    policyHints: [],
    directionForecast: [],
    finished: false,
    cancelled: false,
    error: null,
    apply: vi.fn(),
    cancel: vi.fn(),
    askWhy: vi.fn(),
    ...verify,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<MultiverseCard jobId="job-1" />);
  });
  return container;
}

describe('MultiverseCard counterfactual notices', () => {
  it('renders learned and policy lines from counterfactual telemetry', () => {
    const view = renderWithVerify({
      learnedLines: ['Selector preferred smaller branch over Arbiter recommendation.'],
      policyHints: ['lower size tolerance unless proof delta is large'],
    });

    expect(view.querySelector('[data-testid="counterfactual-learned-line"]')?.textContent)
      .toContain('Selector preferred smaller branch');
    expect(view.querySelector('[data-testid="counterfactual-policy-hint"]')?.textContent)
      .toContain('lower size tolerance');
    expect(view.querySelector('[data-testid="counterfactual-ambiguity-note"]')).toBeNull();
  });

  it('renders cancellation ambiguity without inventing a branch lesson', () => {
    const view = renderWithVerify({
      cancelled: true,
      learnedLines: [],
    });

    expect(view.querySelector('[data-testid="counterfactual-ambiguity-note"]')?.textContent)
      .toContain('no branch rejection lesson');
    expect(view.querySelector('[data-testid="counterfactual-learned-line"]')).toBeNull();
  });
});
