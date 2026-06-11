// Per-provider hosted defaults + OAuth endpoints. baseUrl overrides host for self-hosted.
const HOSTS = {
  github: { api: 'https://api.github.com', authorize: 'https://github.com/login/oauth/authorize',
            token: 'https://github.com/login/oauth/access_token', device: 'https://github.com/login/device/code' },
  gitlab: { api: 'https://gitlab.com/api/v4', authorize: 'https://gitlab.com/oauth/authorize',
            token: 'https://gitlab.com/oauth/token', device: 'https://gitlab.com/oauth/authorize_device' },
  generic: { api: null, authorize: null, token: null, device: null },
};

/** Resolve the REST API base for a connection (baseUrl wins for self-hosted). */
export function resolveApiBase(conn) {
  if (conn.baseUrl) {
    const root = conn.baseUrl.replace(/\/+$/, '');
    return conn.providerType === 'github' ? root : `${root}/api/v4`;
  }
  const h = HOSTS[conn.providerType];
  if (!h?.api) throw Object.assign(new Error('baseUrl required'), { code: 'config_error' });
  return h.api;
}

// OAuth app credentials per provider. GitHub git-OAuth deliberately reuses NextAuth login's
// GITHUB_ID/GITHUB_SECRET (auth.js) rather than a separate GITHUB_CLIENT_ID/SECRET pair.
const OAUTH_CLIENT_ENV = {
  github: { id: 'GITHUB_ID', secret: 'GITHUB_SECRET' },
  gitlab: { id: 'GITLAB_CLIENT_ID', secret: 'GITLAB_CLIENT_SECRET' },
};

/** Resolve the OAuth app {id, secret} for a provider from the environment. */
export function oauthClient(provider) {
  const e = OAUTH_CLIENT_ENV[provider];
  return { id: (e && process.env[e.id]) || '', secret: (e && process.env[e.secret]) || '' };
}

export function oauthEndpoints(providerType, baseUrl) {
  if (baseUrl) {
    const root = baseUrl.replace(/\/+$/, '');
    return { authorize: `${root}/oauth/authorize`, token: `${root}/oauth/token`, device: `${root}/oauth/authorize_device` };
  }
  const h = HOSTS[providerType];
  return { authorize: h.authorize, token: h.token, device: h.device };
}
