import { describe, expect, it } from 'vitest';
import { getCodeSiteRuntimeConfig } from '../runtimeConfig';

describe('CodeSite runtime configuration', () => {
  it('uses documented safe defaults when optional tuning is absent', () => {
    const config = getCodeSiteRuntimeConfig({});
    expect(config).toMatchObject({
      collabServerUrl: '',
      activityNotificationTimeoutMs: 1_500,
      readinessTimeoutMs: 3_000,
      snapshotMaxFiles: 512,
      maxActiveChannels: 3,
    });
  });

  it('normalizes canonical and legacy collaboration URLs without a localhost fallback', () => {
    expect(getCodeSiteRuntimeConfig({ COLLAB_SERVER_URL: 'ws://collab.test/' }).collabServerUrl).toBe('http://collab.test');
    expect(getCodeSiteRuntimeConfig({ SYNTHI_COLLAB_SERVER_URL: 'https://collab.test/base/' }).collabServerUrl).toBe('https://collab.test/base');
    expect(getCodeSiteRuntimeConfig({ COLLAB_SERVER_URL: 'not a url' }).collabServerUrl).toBe('');
  });

  it('bounds invalid or excessive operational tuning values', () => {
    const config = getCodeSiteRuntimeConfig({
      SYNTHI_CODESITE_READINESS_TIMEOUT_MS: '-1',
      SYNTHI_CODESITE_INSPECTION_MAX_TIMEOUT_MS: '99999999',
      SYNTHI_CODESITE_INSPECTION_TIMEOUT_MS: '99999999',
      SYNTHI_CODESITE_MAX_ACTIVE_CHANNELS: '0',
    });
    expect(config.readinessTimeoutMs).toBe(3_000);
    expect(config.inspectionMaxTimeoutMs).toBe(600_000);
    expect(config.inspectionTimeoutMs).toBe(600_000);
    expect(config.maxActiveChannels).toBe(3);
  });
});
