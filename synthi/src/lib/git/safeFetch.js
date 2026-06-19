import { assertSafeUrl } from '@synthi/mcp-hub';

/** fetch() gated by the Slice-1 SSRF guard. Throws (does not fetch) on unsafe URLs. */
export async function gitFetch(url, init) {
  await assertSafeUrl(url);
  return fetch(url, init);
}
