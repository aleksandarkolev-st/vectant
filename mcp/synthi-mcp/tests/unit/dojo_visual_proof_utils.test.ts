import { describe, expect, it } from "vitest";

import {
  evaluateVisualProofCapture,
} from "../../../../synthi/scripts/dojo-visual-proof-utils.mjs";

const viewport = { name: "desktop", width: 1440, height: 1100 };

function validImageMetrics(overrides: Record<string, unknown> = {}) {
  return {
    pixel_metrics_verified: true,
    width: 1440,
    height: 1400,
    channels: 4,
    pixel_count: 2_016_000,
    visible_pixel_count: 2_016_000,
    visible_pixel_ratio: 1,
    unique_color_sample_count: 96,
    mean_luma: 22,
    luma_stddev: 18,
    min_luma: 4,
    max_luma: 255,
    background_rgb: [5, 7, 13],
    background_diff_pixel_count: 300_000,
    background_diff_pixel_ratio: 0.15,
    ...overrides,
  };
}

function validLayoutMetrics(overrides: Record<string, unknown> = {}) {
  return {
    selector_found: true,
    selector_visible: true,
    viewport_width: 1440,
    viewport_height: 1100,
    scroll_width: 1440,
    scroll_height: 1400,
    horizontal_overflow_px: 0,
    selector_box: { x: 0, y: 0, width: 1440, height: 1200 },
    selector_visible_area_px: 1_584_000,
    ...overrides,
  };
}

describe("dojo visual proof utility", () => {
  it("accepts a route capture with text, layout, and pixel evidence", () => {
    const decision = evaluateVisualProofCapture({
      checks: { has_heading: true, has_skill: true },
      screenshotBytes: 120_000,
      imageMetrics: validImageMetrics(),
      layoutMetrics: validLayoutMetrics(),
      viewport,
    });

    expect(decision.ok).toBe(true);
    expect(decision.failed_visual_gates).toEqual([]);
  });

  it("fails closed when a screenshot is blank-like even if text checks pass", () => {
    const decision = evaluateVisualProofCapture({
      checks: { has_heading: true },
      screenshotBytes: 120_000,
      imageMetrics: validImageMetrics({
        unique_color_sample_count: 1,
        luma_stddev: 0,
        background_diff_pixel_ratio: 0,
      }),
      layoutMetrics: validLayoutMetrics(),
      viewport,
    });

    expect(decision.ok).toBe(false);
    expect(decision.failed_visual_gates).toEqual(expect.arrayContaining([
      "visual_unique_colors_too_low",
      "visual_luma_stddev_too_low",
      "visual_background_diff_too_low",
    ]));
  });

  it("fails closed when required text, selector visibility, or horizontal layout is invalid", () => {
    const decision = evaluateVisualProofCapture({
      checks: { has_heading: true, has_required_badge: false },
      screenshotBytes: 120_000,
      imageMetrics: validImageMetrics(),
      layoutMetrics: validLayoutMetrics({
        selector_visible: false,
        selector_visible_area_px: 0,
        horizontal_overflow_px: 40,
      }),
      viewport,
    });

    expect(decision.ok).toBe(false);
    expect(decision.failed_visual_gates).toEqual(expect.arrayContaining([
      "required_text_missing",
      "selector_not_visible",
      "selector_visible_area_too_small",
      "horizontal_overflow",
    ]));
  });
});
