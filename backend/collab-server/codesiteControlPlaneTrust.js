'use strict';

function normalize(value) {
  return String(value || '').trim();
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeControlPlaneBaseUrl(value, workspaceSlug = '') {
  const raw = normalize(value);
  if (!raw) return null;
  const withWorkspace = raw.replace('{workspace_slug}', encodeURIComponent(workspaceSlug || ''));
  try {
    const url = new URL(withWorkspace);
    url.hash = '';
    url.search = '';
    return trimTrailingSlash(url.toString());
  } catch (_) {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function configuredControlPlaneBaseUrls(workspaceSlug = '') {
  const slug = normalize(workspaceSlug);
  const direct = [
    process.env.SYNTHI_CODESITE_API_BASE_URL,
    process.env.CODESITE_API_BASE_URL,
  ].map((value) => normalizeControlPlaneBaseUrl(value, slug));

  const appOrigins = [
    process.env.SYNTHI_CODESITE_BASE_URL,
    process.env.SYNTHI_APP_INTERNAL_URL,
    process.env.SYNTHI_APP_URL,
    process.env.SYNTHI_PUBLIC_APP_URL,
    process.env.NEXTAUTH_URL,
  ].map((value) => {
    const origin = normalizeControlPlaneBaseUrl(value, slug);
    if (!origin || !slug) return null;
    return `${origin}/api/workspace/${encodeURIComponent(slug)}/codesite`;
  });

  return unique([...direct, ...appOrigins]);
}

function configuredControlPlaneBaseUrl(workspaceSlug = '') {
  return configuredControlPlaneBaseUrls(workspaceSlug)[0] || null;
}

function isTrustedControlPlaneBaseUrl(value, workspaceSlug = '', options = {}) {
  const normalized = normalizeControlPlaneBaseUrl(value, workspaceSlug);
  if (!normalized) return false;
  if (options.authenticatedInternal === true || options.controlPlaneTrusted === true) return true;
  return configuredControlPlaneBaseUrls(workspaceSlug).includes(normalized);
}

function trustedControlPlaneBaseUrl(value, workspaceSlug = '', options = {}) {
  const normalized = normalizeControlPlaneBaseUrl(value, workspaceSlug);
  if (!normalized) return null;
  return isTrustedControlPlaneBaseUrl(normalized, workspaceSlug, options) ? normalized : null;
}

function resolveTrustedControlPlaneBaseUrl(workspaceSlug = '', options = {}) {
  const explicit = options.controlPlaneUrl || options.control_plane_url;
  if (explicit) {
    return trustedControlPlaneBaseUrl(explicit, workspaceSlug, options);
  }
  return configuredControlPlaneBaseUrl(workspaceSlug);
}

module.exports = {
  configuredControlPlaneBaseUrl,
  configuredControlPlaneBaseUrls,
  isTrustedControlPlaneBaseUrl,
  normalizeControlPlaneBaseUrl,
  resolveTrustedControlPlaneBaseUrl,
  trustedControlPlaneBaseUrl,
};
