/**
 * DNS-rebinding & redirect-safe fetch for the External MCP Client hub.
 *
 * The pre-flight `assertSafeUrl` check in the client is necessary but not
 * sufficient: between the check and the actual connect, a hostile DNS server can
 * rebind the name to a private IP (a TOCTOU window), and a remote server can
 * issue a redirect to an internal URL. `createGuardedFetch` closes both holes by
 * re-validating the destination immediately before EVERY network hop and by
 * following redirects manually so each hop is re-checked.
 */

import { assertSafeUrl } from './ssrfGuard.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Create a guarded fetch function (shape matches the MCP SDK's `FetchLike`).
 *
 * @param {object}   [options]
 * @param {string[]} [options.allowlist]    Host allowlist passed to assertSafeUrl.
 * @param {Function} [options.lookup]       Injected DNS lookup (deterministic in tests).
 * @param {Function} [options.baseFetch]    Underlying fetch (defaults to globalThis.fetch).
 * @param {number}   [options.maxRedirects] Max redirects to follow before failing (default 3).
 * @returns {(url: string|URL, init?: RequestInit) => Promise<Response>}
 */
export function createGuardedFetch({
  allowlist = [],
  lookup,
  baseFetch = globalThis.fetch,
  maxRedirects = 3,
} = {}) {
  return async function guardedFetch(url, init) {
    let currentUrl = typeof url === 'string' ? url : String(url);
    let redirects = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // (1) Re-validate the destination immediately before the network call.
      //     On a DNS rebind this second resolution is re-checked and blocked.
      //     assertSafeUrl sets `.code = 'ssrf_blocked'` on rejection — let it propagate.
      await assertSafeUrl(currentUrl, { allowlist, lookup });

      // (2) Never let the underlying fetch auto-follow redirects.
      const res = await baseFetch(currentUrl, { ...init, redirect: 'manual' });

      // (3) Follow redirects manually so every hop is re-validated.
      const location = res && res.headers && typeof res.headers.get === 'function'
        ? res.headers.get('location')
        : null;
      if (REDIRECT_STATUSES.has(res && res.status) && location) {
        if (redirects >= maxRedirects) {
          const e = new Error(`Blocked: too many redirects (> ${maxRedirects})`);
          e.code = 'ssrf_blocked';
          throw e;
        }
        redirects += 1;
        // Resolve relative redirects against the current URL, then loop to (1).
        // Carry method/body across hops exactly as given (no 303 method rewrite);
        // every hop is re-validated, which keeps this simple and safe.
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // (5) Non-redirect responses are returned as-is.
      return res;
    }
  };
}
