/**
 * Server-only CodeSite runtime configuration.
 *
 * This is intentionally the only place that reads CodeSite tuning variables.
 * Secrets remain opaque and are never included in values returned to clients.
 */
const DEFAULTS = Object.freeze({
  activityNotificationTimeoutMs: 1_500,
  readinessTimeoutMs: 3_000,
  inboxDeliveryTimeoutMs: 1_500,
  inspectionTimeoutMs: 30_000,
  inspectionMaxTimeoutMs: 120_000,
  shadowRunnerTimeoutMs: 120_000,
  shadowRunnerMaxTimeoutMs: 600_000,
  repoScanMaxFiles: 12_000,
  snapshotMaxFiles: 512,
  snapshotMaxFileBytes: 2 * 1024 * 1024,
  snapshotMaxScanEntries: 15_000,
  artifactPathHistoryMaxBytes: 4 * 1024 * 1024,
  maxActiveChannels: 3,
  maxActiveFleetNotamsPerRoute: 25,
});

function firstValue(env, keys) {
  for (const key of keys) {
    const value = env[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function positiveInt(value, fallback, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(Math.floor(numeric), max);
}

function httpUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value.replace(/^ws/i, 'http'));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

/** Resolve runtime inputs. Legacy aliases are supported only for migration. */
export function getCodeSiteRuntimeConfig(env = process.env) {
  const inspectionMaxTimeoutMs = positiveInt(
    env.SYNTHI_CODESITE_INSPECTION_MAX_TIMEOUT_MS,
    DEFAULTS.inspectionMaxTimeoutMs,
    { max: DEFAULTS.shadowRunnerMaxTimeoutMs },
  );
  return Object.freeze({
    collabServerUrl: httpUrl(firstValue(env, [
      'COLLAB_SERVER_URL', 'SYNTHI_COLLAB_SERVER_URL', 'NEXT_PUBLIC_COLLAB_SERVER_URL', 'COLLAB_URL',
    ])),
    collabInternalToken: firstValue(env, ['COLLAB_INTERNAL_TOKEN', 'SYNTHI_COLLAB_INTERNAL_TOKEN']),
    activityNotificationTimeoutMs: positiveInt(env.SYNTHI_CODESITE_ACTIVITY_NOTIFICATION_TIMEOUT_MS, DEFAULTS.activityNotificationTimeoutMs, { max: 60_000 }),
    readinessTimeoutMs: positiveInt(env.SYNTHI_CODESITE_READINESS_TIMEOUT_MS, DEFAULTS.readinessTimeoutMs, { max: 60_000 }),
    inboxDeliveryTimeoutMs: positiveInt(env.SYNTHI_CODESITE_INBOX_DELIVERY_TIMEOUT_MS, DEFAULTS.inboxDeliveryTimeoutMs, { max: 120_000 }),
    inspectionTimeoutMs: positiveInt(env.SYNTHI_CODESITE_INSPECTION_TIMEOUT_MS, DEFAULTS.inspectionTimeoutMs, { max: inspectionMaxTimeoutMs }),
    inspectionMaxTimeoutMs,
    shadowRunnerTimeoutMs: positiveInt(env.SYNTHI_CODESITE_SHADOW_RUNNER_TIMEOUT_MS, DEFAULTS.shadowRunnerTimeoutMs, { max: DEFAULTS.shadowRunnerMaxTimeoutMs }),
    shadowRunnerMaxTimeoutMs: DEFAULTS.shadowRunnerMaxTimeoutMs,
    repoScanMaxFiles: positiveInt(env.SYNTHI_CODESITE_REPO_SCAN_MAX_FILES, DEFAULTS.repoScanMaxFiles),
    snapshotMaxFiles: positiveInt(env.SYNTHI_CODESITE_SNAPSHOT_MAX_FILES, DEFAULTS.snapshotMaxFiles),
    snapshotMaxFileBytes: positiveInt(env.SYNTHI_CODESITE_SNAPSHOT_MAX_FILE_BYTES, DEFAULTS.snapshotMaxFileBytes),
    snapshotMaxScanEntries: positiveInt(env.SYNTHI_CODESITE_SNAPSHOT_MAX_SCAN_ENTRIES, DEFAULTS.snapshotMaxScanEntries),
    artifactPathHistoryMaxBytes: positiveInt(env.SYNTHI_CODESITE_ARTIFACT_PATH_HISTORY_MAX_BYTES, DEFAULTS.artifactPathHistoryMaxBytes),
    maxActiveChannels: positiveInt(env.SYNTHI_CODESITE_MAX_ACTIVE_CHANNELS, DEFAULTS.maxActiveChannels),
    maxActiveFleetNotamsPerRoute: positiveInt(
      env.SYNTHI_CODESITE_MAX_FLEET_NOTAMS_PER_ROUTE,
      DEFAULTS.maxActiveFleetNotamsPerRoute,
    ),
  });
}

export { DEFAULTS as CODE_SITE_RUNTIME_DEFAULTS };
