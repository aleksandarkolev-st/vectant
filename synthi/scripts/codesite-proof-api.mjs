export function proofAuthCookieHeader() {
  return String(process.env.CODESITE_PROOF_AUTH_COOKIE || '').trim();
}

export function proofAuthSecret() {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || '';
}

export function proofActorForSlug(slug, overrides = {}) {
  const suffix = String(slug || 'codesite-proof').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return {
    name: overrides.name || 'CodeSite Proof Owner',
    email: overrides.email || `codesite-proof-owner+${suffix}@example.test`,
    sessionUserId: overrides.sessionUserId || `${suffix}-owner`,
  };
}

export async function nextAuthCookieForProofActor(actor) {
  const secret = proofAuthSecret();
  if (!secret) {
    throw new Error('AUTH_SECRET or NEXTAUTH_SECRET is required to mint temporary CodeSite proof sessions; alternatively set CODESITE_PROOF_AUTH_COOKIE');
  }
  const { encode } = await import('next-auth/jwt');
  const token = await encode({
    secret,
    token: {
      name: actor.name,
      email: actor.email,
      sub: actor.sessionUserId,
      userId: actor.sessionUserId,
      picture: null,
    },
    maxAge: 60 * 60,
  });
  return `next-auth.session-token=${token}`;
}

export async function proofAuthCookieForSlug(slug, options = {}) {
  const explicit = proofAuthCookieHeader();
  const actor = proofActorForSlug(slug, options.actor || {});
  if (explicit) return { authCookie: explicit, actor, mode: 'provided_cookie' };
  return {
    authCookie: await nextAuthCookieForProofActor(actor),
    actor,
    mode: 'generated_nextauth_jwt',
  };
}

export function authCookiesForBaseUrl(baseUrl, cookieHeader) {
  if (!cookieHeader) return [];
  const url = baseUrl.replace(/\/+$/, '');
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      if (separator <= 0) return null;
      return {
        name: part.slice(0, separator),
        value: part.slice(separator + 1),
        url,
      };
    })
    .filter(Boolean);
}

export async function addAuthCookiesToBrowserContext(context, baseUrl, authCookie) {
  const cookies = authCookiesForBaseUrl(baseUrl, authCookie);
  if (cookies.length) await context.addCookies(cookies);
  return cookies;
}

export async function parseJsonResponse(response, route, method) {
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${route} returned ${response.status}: ${JSON.stringify(body)}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export function createAuthenticatedAppApi(baseUrl, { authCookie = '' } = {}) {
  const appBase = baseUrl.replace(/\/+$/, '');
  async function appApi(route, options = {}) {
    const response = await fetch(`${appBase}${route}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(authCookie ? { cookie: authCookie } : {}),
        ...(options.headers || {}),
      },
    });
    return parseJsonResponse(response, route, options.method || 'GET');
  }
  appApi.baseUrl = appBase;
  return appApi;
}

export function createAuthenticatedCodeSiteApi(baseUrl, slug, {
  authCookie = '',
  rejectRoute = null,
  trackRoutes = false,
} = {}) {
  const apiBase = `${baseUrl.replace(/\/+$/, '')}/api/workspace/${encodeURIComponent(slug)}/codesite`;
  const calledRoutes = [];
  async function raw(route, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (trackRoutes) calledRoutes.push(`${method} ${route}`);
    if (typeof rejectRoute === 'function' && rejectRoute(route, method)) {
      throw new Error(`proof route rejected by harness policy: ${method} ${route}`);
    }
    const response = await fetch(`${apiBase}${route}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(authCookie ? { cookie: authCookie } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { ok: response.ok, status: response.status, body };
  }
  async function api(route, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const response = await raw(route, options);
    if (response.ok) return response.body;
    const error = new Error(`${method} ${route} returned ${response.status}: ${JSON.stringify(response.body)}`);
    error.status = response.status;
    error.body = response.body;
    throw error;
  }
  api.baseUrl = apiBase;
  api.raw = raw;
  api.calledRoutes = calledRoutes;
  return api;
}

export async function ensureProofWorkspace(baseUrl, slug, options = {}) {
  const auth = await proofAuthCookieForSlug(slug, options);
  const app = createAuthenticatedAppApi(baseUrl, { authCookie: auth.authCookie });
  try {
    await app('/api/workspace', {
      method: 'POST',
      body: JSON.stringify({
        name: options.workspaceName || `CodeSite proof ${slug}`,
        slug,
        repoUrl: options.repoUrl || `proof://${slug}`,
      }),
    });
  } catch (error) {
    const optionalWorkspaceItemFailed = error.status === 500
      && /workspace item/i.test(String(error.body?.error || error.message || ''));
    if (error.status !== 409 && !optionalWorkspaceItemFailed) throw error;
  }
  return {
    ...auth,
    app,
    api: createAuthenticatedCodeSiteApi(baseUrl, slug, {
      authCookie: auth.authCookie,
      ...(options.apiOptions || {}),
    }),
  };
}
