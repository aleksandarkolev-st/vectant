import { describe, expect, it } from 'vitest';
import { applySelectionResult, reduce } from './useShadowVerify.js';

const baseState = {
  universes: {},
  learnedLines: [],
  policyDeltas: [],
  policyHints: [],
  directionForecast: [],
  cancelled: false,
  error: null,
};

describe('useShadowVerify counterfactual events', () => {
  it('stores learned lines from SSE events', () => {
    const state = reduce(baseState, {
      type: 'counterfactual_learned',
      learned_lines: ['Runtime branch beat the smaller local patch.'],
      policy_deltas: [{ id: 'pdelta_1' }],
    });

    expect(state.learnedLines).toEqual(['Runtime branch beat the smaller local patch.']);
    expect(state.policyDeltas).toEqual([{ id: 'pdelta_1' }]);
  });

  it('stores policy hints from next-run policy events', () => {
    const state = reduce(baseState, {
      type: 'counterfactual_policy',
      policy_hints: ['raise runtime-primitive universe priority'],
      direction_forecast: [{ direction_id: 'B' }],
    });

    expect(state.policyHints).toEqual(['raise runtime-primitive universe priority']);
    expect(state.directionForecast).toEqual([{ direction_id: 'B' }]);
  });

  it('marks cancellation as ambiguous without creating a learned line', () => {
    const state = reduce(baseState, { type: 'error', stage: 'cancel', msg: 'cancelled by user' });

    expect(state.cancelled).toBe(true);
    expect(state.learnedLines).toEqual([]);
  });

  it('merges learned lines from apply responses', () => {
    const state = applySelectionResult(
      { ...baseState, learnedLines: ['Existing line'] },
      { learned_lines: ['Existing line', 'Selector preferred smaller branch.'] },
    );

    expect(state.learnedLines).toEqual(['Existing line', 'Selector preferred smaller branch.']);
  });
});
