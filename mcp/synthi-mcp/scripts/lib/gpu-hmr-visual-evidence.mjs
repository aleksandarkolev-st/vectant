import sharp from 'sharp';

const MIN_VISUAL_WIDTH = 320;
const MIN_VISUAL_HEIGHT = 240;
const MIN_VISIBLE_PIXELS = 500;
const FLAT_LUMA_STDDEV = 4;
const FLAT_RGB_SPAN_MEAN = 12;
const FLAT_UNIQUE_COLOR_SAMPLE_COUNT = 16;

function numeric(value) {
  return Number.isFinite(value) ? value : null;
}

export function classifyGpuHmrVisualEvidenceStats(stats = {}) {
  const width = Number(stats.width);
  const height = Number(stats.height);
  const visiblePixels = Number(stats.visible_pixels ?? stats.visiblePixels);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'gpu-hmr-visual-unmeasured';
  }
  if (width < MIN_VISUAL_WIDTH || height < MIN_VISUAL_HEIGHT) {
    return 'gpu-hmr-visual-too-small';
  }
  if (!Number.isFinite(visiblePixels) || visiblePixels <= 0) {
    return 'gpu-hmr-visual-blank';
  }
  if (visiblePixels <= MIN_VISIBLE_PIXELS) {
    return 'gpu-hmr-visual-low-visible-pixels';
  }

  const lumaStddev = Number(stats.luma_stddev ?? stats.lumaStddev);
  const rgbSpanMean = Number(stats.rgb_span_mean ?? stats.rgbSpanMean);
  const uniqueColorSampleCount = Number(
    stats.unique_color_sample_count ?? stats.uniqueColorSampleCount,
  );
  const hasVariation = (
    (Number.isFinite(lumaStddev) && lumaStddev >= FLAT_LUMA_STDDEV)
    || (Number.isFinite(rgbSpanMean) && rgbSpanMean >= FLAT_RGB_SPAN_MEAN)
    || (Number.isFinite(uniqueColorSampleCount)
      && uniqueColorSampleCount >= FLAT_UNIQUE_COLOR_SAMPLE_COUNT)
  );
  return hasVariation ? 'gpu-hmr-visual-varied-frame' : 'gpu-hmr-visual-flat-frame';
}

export function screenshotQualifiesAsVisualEvidence(shot) {
  const quality = shot?.visual_quality ?? shot?.visualQuality ?? classifyGpuHmrVisualEvidenceStats(shot);
  return Boolean(
    shot
      && Number(shot.width) >= MIN_VISUAL_WIDTH
      && Number(shot.height) >= MIN_VISUAL_HEIGHT
      && Number(shot.visible_pixels ?? shot.visiblePixels) > MIN_VISIBLE_PIXELS
      && quality === 'gpu-hmr-visual-varied-frame'
      && typeof (shot.path ?? shot.filePath ?? shot.file_path) === 'string'
      && String(shot.path ?? shot.filePath ?? shot.file_path).trim(),
  );
}

export async function analyzeGpuHmrImageEvidence(input) {
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let visible = 0;
  let lumaTotal = 0;
  let lumaSquareTotal = 0;
  const minChannel = [255, 255, 255];
  const maxChannel = [0, 0, 0];
  const uniqueSamples = new Set();
  const pixels = Math.max(1, info.width * info.height);
  const sampleStride = Math.max(1, Math.floor(pixels / 8192));
  let pixelIndex = 0;

  for (let i = 0; i < data.length; i += info.channels) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaTotal += luma;
    lumaSquareTotal += luma * luma;
    if (luma > 24 || Math.max(r, g, b) - Math.min(r, g, b) > 30) visible += 1;
    minChannel[0] = Math.min(minChannel[0], r);
    minChannel[1] = Math.min(minChannel[1], g);
    minChannel[2] = Math.min(minChannel[2], b);
    maxChannel[0] = Math.max(maxChannel[0], r);
    maxChannel[1] = Math.max(maxChannel[1], g);
    maxChannel[2] = Math.max(maxChannel[2], b);
    if (pixelIndex % sampleStride === 0) {
      uniqueSamples.add(`${r},${g},${b}`);
    }
    pixelIndex += 1;
  }

  const meanLuma = lumaTotal / pixels;
  const variance = Math.max(0, (lumaSquareTotal / pixels) - (meanLuma * meanLuma));
  const rgbSpanMean = (
    (maxChannel[0] - minChannel[0])
    + (maxChannel[1] - minChannel[1])
    + (maxChannel[2] - minChannel[2])
  ) / 3;
  const stats = {
    width: info.width,
    height: info.height,
    visible_pixels: visible,
    mean_luma: meanLuma,
    luma_stddev: Math.sqrt(variance),
    rgb_span_mean: rgbSpanMean,
    unique_color_sample_count: uniqueSamples.size,
  };
  return {
    ...stats,
    visual_quality: classifyGpuHmrVisualEvidenceStats(stats),
  };
}

export function visualEvidenceRow(extra = {}) {
  const row = {
    ...extra,
    width: numeric(Number(extra.width)),
    height: numeric(Number(extra.height)),
    visible_pixels: numeric(Number(extra.visible_pixels ?? extra.visiblePixels)),
    mean_luma: numeric(Number(extra.mean_luma ?? extra.meanLuma)),
    luma_stddev: numeric(Number(extra.luma_stddev ?? extra.lumaStddev)),
    rgb_span_mean: numeric(Number(extra.rgb_span_mean ?? extra.rgbSpanMean)),
    unique_color_sample_count: numeric(Number(
      extra.unique_color_sample_count ?? extra.uniqueColorSampleCount,
    )),
  };
  row.visual_quality = extra.visual_quality
    ?? extra.visualQuality
    ?? classifyGpuHmrVisualEvidenceStats(row);
  row.accepted_as_visual_evidence = screenshotQualifiesAsVisualEvidence(row);
  return row;
}
