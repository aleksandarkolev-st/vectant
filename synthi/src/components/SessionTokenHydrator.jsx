'use client';

import { useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { useDispatch } from 'react-redux';
import { setGithubToken } from '@/lib/githubToken';
import { setHasToken } from '@/redux/prSlice';

const LEGACY_GLOBAL_KEY = 'synthi:global-github-token';
const LEGACY_PER_WS_PREFIX = 'synthi:github-token:';

/**
 * Bridges session.githubToken into the in-memory cache so that non-React
 * modules (Redux thunks, prClient) can read it synchronously, and mirrors
 * the same value into Redux as pr.hasToken so PR-list/githubInfo effects
 * auto-refresh when a token arrives (initial session load OR Settings save).
 *
 * Also performs a one-shot migration of any legacy localStorage tokens into
 * the server-side per-user store, then wipes them.
 */
export default function SessionTokenHydrator() {
  const { data: session, status, update } = useSession();
  const dispatch = useDispatch();

  useEffect(() => {
    if (status === 'loading') return;
    const tok = session?.githubToken || null;
    setGithubToken(tok, session?.githubTokenSource || null);
    dispatch(setHasToken(!!tok));
  }, [status, session?.githubToken, session?.githubTokenSource, dispatch]);

  useEffect(() => {
    if (status !== 'authenticated' || typeof window === 'undefined') return;
    if (session?.githubTokenSource === 'pat') {
      // Server already has a PAT — drop any legacy localStorage tokens
      cleanupLegacyTokens();
      return;
    }
    const legacy = findLegacyToken();
    if (!legacy) return;

    (async () => {
      try {
        const res = await fetch('/api/user/github-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: legacy }),
        });
        if (res.ok) {
          cleanupLegacyTokens();
          // Refresh the session so session.githubToken picks up the new PAT
          if (typeof update === 'function') update();
        } else {
          // Token was invalid/expired — still clean it up so it doesn't keep retrying
          cleanupLegacyTokens();
        }
      } catch (_) {
        // Network error — leave the legacy token in place; we'll retry next mount
      }
    })();
  }, [status, session?.githubTokenSource, update]);

  return null;
}

function findLegacyToken() {
  try {
    const global = localStorage.getItem(LEGACY_GLOBAL_KEY);
    if (global) return global;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LEGACY_PER_WS_PREFIX)) {
        const v = localStorage.getItem(key);
        if (v) return v;
      }
    }
  } catch (_) { /* storage disabled */ }
  return null;
}

function cleanupLegacyTokens() {
  try {
    localStorage.removeItem(LEGACY_GLOBAL_KEY);
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LEGACY_PER_WS_PREFIX)) toRemove.push(key);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch (_) { /* storage disabled */ }
}
