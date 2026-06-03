import { describe, it, expect, beforeEach } from 'vitest';
import { oauthClient } from '../providerConfig.js';

describe('oauthClient', () => {
  beforeEach(() => {
    for (const k of ['GITHUB_ID', 'GITHUB_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
      'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET']) delete process.env[k];
  });

  it('maps github to NextAuth GITHUB_ID/GITHUB_SECRET (shared with login)', () => {
    process.env.GITHUB_ID = 'ghid';
    process.env.GITHUB_SECRET = 'ghsec';
    expect(oauthClient('github')).toEqual({ id: 'ghid', secret: 'ghsec' });
  });

  it('does NOT read GITHUB_CLIENT_ID/SECRET for github', () => {
    process.env.GITHUB_CLIENT_ID = 'wrong';
    process.env.GITHUB_CLIENT_SECRET = 'wrong';
    expect(oauthClient('github')).toEqual({ id: '', secret: '' });
  });

  it('maps gitlab to GITLAB_CLIENT_ID/GITLAB_CLIENT_SECRET', () => {
    process.env.GITLAB_CLIENT_ID = 'glid';
    process.env.GITLAB_CLIENT_SECRET = 'glsec';
    expect(oauthClient('gitlab')).toEqual({ id: 'glid', secret: 'glsec' });
  });

  it('falls back to empty strings when the env vars are unset', () => {
    expect(oauthClient('gitlab')).toEqual({ id: '', secret: '' });
  });
});
