export function buildUpstreamLifecyclePlan({
  buildMetadataDir = '',
  buildUpstream = true,
  runUpstream = true,
} = {}) {
  const cachedMetadataDir = typeof buildMetadataDir === 'string' ? buildMetadataDir.trim() : '';
  const usesCachedMetadata = cachedMetadataDir.length > 0;
  const executeLifecycle = !usesCachedMetadata || buildUpstream === true || runUpstream === true;
  return {
    usesCachedMetadata,
    cachedMetadataDir: usesCachedMetadata ? cachedMetadataDir : null,
    executeLifecycle,
    metadataSource: usesCachedMetadata ? 'cached' : 'worker-build',
    skipReason: executeLifecycle ? null : 'cached_metadata_without_requested_build_or_run',
  };
}

export function normalizeUpstreamDisplayMode(value = 'auto') {
  const mode = String(value ?? 'auto').trim().toLowerCase();
  if (!mode || mode === 'auto') return 'auto';
  if (mode === 'none' || mode === 'off' || mode === 'disabled' || mode === '0') return 'none';
  if (mode === 'xvfb' || mode === 'xvfb-run' || mode === 'virtual') return 'xvfb';
  throw new Error(`invalid upstream display mode: ${value}`);
}

export function buildUpstreamRunLaunchPlan({
  runUpstream = true,
  displayMode = 'auto',
  xvfbRunAvailable = false,
  xdgRuntimeDir = '',
  workerTempDir = '/tmp/synthi-real-rocm',
  width = 800,
  height = 600,
} = {}) {
  const requestedDisplayMode = normalizeUpstreamDisplayMode(displayMode);
  const tempRoot = String(workerTempDir || '/tmp/synthi-real-rocm').replace(/\/+$/g, '');
  const runtimeDir = String(xdgRuntimeDir || '').trim() || `${tempRoot}/xdg-runtime`;
  const normalizedWidth = Number.isFinite(Number(width)) && Number(width) > 0
    ? Math.trunc(Number(width))
    : 800;
  const normalizedHeight = Number.isFinite(Number(height)) && Number(height) > 0
    ? Math.trunc(Number(height))
    : 600;
  const xvfbAvailable = Boolean(xvfbRunAvailable);
  const effectiveDisplayMode = !runUpstream
    ? 'skipped'
    : requestedDisplayMode === 'auto'
      ? (xvfbAvailable ? 'xvfb' : 'none')
      : requestedDisplayMode;
  const runnable = !runUpstream || effectiveDisplayMode !== 'xvfb' || xvfbAvailable;
  const reason = !runUpstream
    ? 'upstream_run_disabled'
    : effectiveDisplayMode === 'xvfb' && xvfbAvailable
      ? 'xvfb_run_available'
      : effectiveDisplayMode === 'xvfb'
        ? 'xvfb_requested_but_unavailable'
        : requestedDisplayMode === 'auto'
          ? 'xvfb_run_unavailable'
          : 'display_disabled_by_configuration';

  return {
    runUpstream: Boolean(runUpstream),
    requestedDisplayMode,
    effectiveDisplayMode,
    useXvfbRun: runnable && effectiveDisplayMode === 'xvfb',
    xvfbRunAvailable: xvfbAvailable,
    runnable,
    reason,
    xdgRuntimeDir: runtimeDir,
    screen: `${normalizedWidth}x${normalizedHeight}x24`,
  };
}

export function canContinueWithCachedMetadataAfterLifecycleFailure({
  usesCachedMetadata = false,
  cachedMetadataAvailable = false,
} = {}) {
  return Boolean(usesCachedMetadata && cachedMetadataAvailable);
}
