import { describe, expect, it } from 'vitest';

import { computeFitScale } from '../ScaleToFitFrame';

describe('computeFitScale', () => {
  it('is 1 when the container matches the base', () => {
    expect(computeFitScale(1280, 800, 1280, 800)).toBe(1);
  });

  it('scales down to fit a smaller container', () => {
    expect(computeFitScale(640, 400, 1280, 800)).toBe(0.5);
  });

  it('scales up to fill a larger container', () => {
    expect(computeFitScale(2560, 1600, 1280, 800)).toBe(2);
  });

  it('uses the limiting axis to preserve aspect (letterbox)', () => {
    // wide-but-short container → limited by height
    expect(computeFitScale(2560, 800, 1280, 800)).toBe(1);
    // narrow-but-tall container → limited by width
    expect(computeFitScale(1280, 1600, 1280, 800)).toBe(1);
  });

  it('guards against zero / missing dimensions (returns 1)', () => {
    expect(computeFitScale(0, 800, 1280, 800)).toBe(1);
    expect(computeFitScale(1280, 0, 1280, 800)).toBe(1);
    expect(computeFitScale(1280, 800, 0, 800)).toBe(1);
    expect(computeFitScale(undefined, 800, 1280, 800)).toBe(1);
  });
});
