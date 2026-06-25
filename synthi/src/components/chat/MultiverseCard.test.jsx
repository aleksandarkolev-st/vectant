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
    reviewedUniverseIds: [],
    finished: false,
    cancelled: false,
    error: null,
    apply: vi.fn(),
    cancel: vi.fn(),
    askWhy: vi.fn(),
    markUniverseReviewed: vi.fn(),
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

  it('renders visual proof artifact metadata for generated output', () => {
    const view = renderWithVerify({
      universes: {
        A: {
          id: 'A',
          stage: 'done',
          modelGen: 'gpt',
          modelCritic: 'claude',
          style: 'safe',
          evidence: {
            diagnostics: { lint: 'clean', types: 'clean', tests: '1/1 passed', runtime: 'clean' },
            attacks: { tested: 0, survived: 0, failed: [] },
            loc: '+1 -0',
            score: 1,
            visual_proof: {
              status: 'passed',
              screenshot_sha256: 'abcdef1234567890',
              raw_artifact_ref: 'artifacts/shadow/A-desktop.png',
              viewport: 'desktop',
            },
          },
        },
      },
    });

    const proof = view.querySelector('[data-testid="visual-proof-A"]');
    expect(proof?.textContent).toContain('Visual proof passed');
    expect(proof?.textContent).toContain('abcdef123456');
    expect(proof?.textContent).toContain('artifacts/shadow/A-desktop.png');
  });

  it('marks a universe as reviewed before applying comparison evidence', () => {
    const markUniverseReviewed = vi.fn();
    const view = renderWithVerify({
      markUniverseReviewed,
      universes: {
        A: {
          id: 'A',
          stage: 'done',
          modelGen: 'gpt',
          modelCritic: 'gpt',
          style: 'safe',
          evidence: {
            diagnostics: { lint: 'clean', types: 'clean', tests: '1/1 passed', runtime: 'clean' },
            attacks: { tested: 0, survived: 0, failed: [] },
            loc: '+1 -0',
            score: 1,
          },
        },
      },
    });

    act(() => {
      view.querySelector('.genome-universe__review').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(markUniverseReviewed).toHaveBeenCalledWith('A');
  });
});
