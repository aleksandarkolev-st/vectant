export const DEFAULT_VISUAL_PROOF_THRESHOLDS = Object.freeze({
  min_screenshot_bytes: 10_000,
  min_unique_color_sample_count: 24,
  min_luma_stddev: 2,
  min_background_diff_pixel_ratio: 0.01,
  max_horizontal_overflow_px: 4,
  min_selector_visible_area_px: 900,
});

export async function analyzeScreenshotVisualEvidence({
  sharp,
  screenshotPath,
  backgroundToleranceRgbSum = 18,
  maxColorSamples = 8192,
}) {
  if (typeof sharp !== "function") {
    throw new Error("visual_proof_sharp_required");
  }
  const { data, info } = await sharp(screenshotPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels || 4;
  const pixelCount = Math.max(1, info.width * info.height);
  const sampleStride = Math.max(1, Math.floor(pixelCount / maxColorSamples));
  const background = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
  const uniqueColorSamples = new Set();
  let visiblePixels = 0;
  let backgroundDiffPixels = 0;
  let lumaTotal = 0;
  let lumaSquareTotal = 0;
  let minLuma = Infinity;
  let maxLuma = -Infinity;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * channels;
    const red = data[offset] ?? 0;
    const green = data[offset + 1] ?? 0;
    const blue = data[offset + 2] ?? 0;
    const alpha = channels >= 4 ? data[offset + 3] ?? 255 : 255;
    if (alpha > 0) visiblePixels += 1;
    const luma = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    lumaTotal += luma;
    lumaSquareTotal += luma * luma;
    minLuma = Math.min(minLuma, luma);
    maxLuma = Math.max(maxLuma, luma);
    const backgroundDiff = Math.abs(red - background[0]) + Math.abs(green - background[1]) + Math.abs(blue - background[2]);
    if (backgroundDiff > backgroundToleranceRgbSum) backgroundDiffPixels += 1;
    if (pixelIndex % sampleStride === 0) {
      uniqueColorSamples.add(`${red >> 4}:${green >> 4}:${blue >> 4}:${alpha >> 6}`);
    }
  }

  const meanLuma = lumaTotal / pixelCount;
  const lumaVariance = Math.max(0, (lumaSquareTotal / pixelCount) - (meanLuma * meanLuma));
  return {
    pixel_metrics_verified: true,
    width: info.width,
    height: info.height,
    channels,
    pixel_count: pixelCount,
    visible_pixel_count: visiblePixels,
    visible_pixel_ratio: visiblePixels / pixelCount,
    unique_color_sample_count: uniqueColorSamples.size,
    mean_luma: meanLuma,
    luma_stddev: Math.sqrt(lumaVariance),
    min_luma: Number.isFinite(minLuma) ? minLuma : 0,
    max_luma: Number.isFinite(maxLuma) ? maxLuma : 0,
    background_rgb: background,
    background_diff_pixel_count: backgroundDiffPixels,
    background_diff_pixel_ratio: backgroundDiffPixels / pixelCount,
  };
}

export async function collectRouteLayoutMetrics(page, selector) {
  return page.evaluate((targetSelector) => {
    const root = document.documentElement;
    const element = document.querySelector(targetSelector);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const scrollWidth = Math.max(root?.scrollWidth || 0, document.body?.scrollWidth || 0);
    const scrollHeight = Math.max(root?.scrollHeight || 0, document.body?.scrollHeight || 0);
    if (!element) {
      return {
        selector_found: false,
        selector_visible: false,
        viewport_width: viewportWidth,
        viewport_height: viewportHeight,
        scroll_width: scrollWidth,
        scroll_height: scrollHeight,
        horizontal_overflow_px: Math.max(0, scrollWidth - viewportWidth),
        selector_box: null,
        selector_visible_area_px: 0,
      };
    }
    const rect = element.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
    const visibleArea = visibleWidth * visibleHeight;
    return {
      selector_found: true,
      selector_visible: rect.width > 0 && rect.height > 0 && visibleArea > 0,
      viewport_width: viewportWidth,
      viewport_height: viewportHeight,
      scroll_width: scrollWidth,
      scroll_height: scrollHeight,
      horizontal_overflow_px: Math.max(0, scrollWidth - viewportWidth),
      selector_box: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      selector_visible_area_px: visibleArea,
    };
  }, selector);
}

export function evaluateVisualProofCapture({
  checks,
  screenshotBytes,
  imageMetrics,
  layoutMetrics,
  viewport,
  thresholds = DEFAULT_VISUAL_PROOF_THRESHOLDS,
}) {
  const failedVisualGates = [];
  const textChecks = Object.values(checks || {});
  if (textChecks.length === 0 || !textChecks.every(Boolean)) {
    failedVisualGates.push("required_text_missing");
  }
  if (!Number.isFinite(screenshotBytes) || screenshotBytes < thresholds.min_screenshot_bytes) {
    failedVisualGates.push("screenshot_too_small");
  }
  if (!imageMetrics?.pixel_metrics_verified) {
    failedVisualGates.push("pixel_metrics_missing");
  } else {
    if (imageMetrics.width < viewport.width) failedVisualGates.push("screenshot_width_below_viewport");
    if (imageMetrics.height < viewport.height) failedVisualGates.push("screenshot_height_below_viewport");
    if (imageMetrics.unique_color_sample_count < thresholds.min_unique_color_sample_count) {
      failedVisualGates.push("visual_unique_colors_too_low");
    }
    if (imageMetrics.luma_stddev < thresholds.min_luma_stddev) {
      failedVisualGates.push("visual_luma_stddev_too_low");
    }
    if (imageMetrics.background_diff_pixel_ratio < thresholds.min_background_diff_pixel_ratio) {
      failedVisualGates.push("visual_background_diff_too_low");
    }
  }
  if (!layoutMetrics?.selector_found) {
    failedVisualGates.push("selector_missing");
  } else {
    if (!layoutMetrics.selector_visible) failedVisualGates.push("selector_not_visible");
    if (layoutMetrics.selector_visible_area_px < thresholds.min_selector_visible_area_px) {
      failedVisualGates.push("selector_visible_area_too_small");
    }
    if (layoutMetrics.horizontal_overflow_px > thresholds.max_horizontal_overflow_px) {
      failedVisualGates.push("horizontal_overflow");
    }
  }

  return {
    ok: failedVisualGates.length === 0,
    failed_visual_gates: failedVisualGates,
    thresholds,
  };
}
