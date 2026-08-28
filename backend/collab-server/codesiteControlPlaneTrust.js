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

function workspaceCodeSiteUrl(value, slug) {
  const origin = normalizeControlPlaneBaseUrl(value, slug);
  if (!origin || !slug) return null;
  return `${origin}/api/workspace/${encodeURIComponent(slug)}/codesite`;
}

// Endpoints an operator explicitly pointed at CodeSite.
function codeSiteConfiguredBaseUrls(slug) {
  return unique([
    normalizeControlPlaneBaseUrl(process.env.SYNTHI_CODESITE_API_BASE_URL, slug),
    normalizeControlPlaneBaseUrl(process.env.CODESITE_API_BASE_URL, slug),
    workspaceCodeSiteUrl(process.env.SYNTHI_CODESITE_BASE_URL, slug),
  ]);
}

// Generic app origins. These are set for unrelated reasons (service discovery, NextAuth),
// so their presence says nothing about whether CodeSite was provisioned.
function appOriginBaseUrls(slug) {
  return unique([
    process.env.SYNTHI_APP_INTERNAL_URL,
    process.env.SYNTHI_APP_URL,
    process.env.SYNTHI_PUBLIC_APP_URL,
    process.env.NEXTAUTH_URL,
  ].map((value) => workspaceCodeSiteUrl(value, slug)));
}

// Trust allowlist: a caller may name any control-plane origin this deployment actually
// serves, including the app origin the frontend derives its own URL from.
function configuredControlPlaneBaseUrls(workspaceSlug = '') {
  const slug = normalize(workspaceSlug);
  return unique([...codeSiteConfiguredBaseUrls(slug), ...appOriginBaseUrls(slug)]);
}

// Default authority to consult when no caller supplied one. Only an explicitly configured
// CodeSite endpoint counts: deriving it from a generic app URL fabricates an authority the
// operator never provisioned, and every workspace mutation then fails closed against an
// endpoint that was never meant to answer.
function configuredControlPlaneBaseUrl(workspaceSlug = '') {
  return codeSiteConfiguredBaseUrls(normalize(workspaceSlug))[0] || null;
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
