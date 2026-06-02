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
