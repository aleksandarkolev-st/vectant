"use client";

import React, { useCallback, useEffect, useRef, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import collabSessionService from '@/services/collabSessionService';
import { Users, Loader2, AlertTriangle, CheckCircle2, XCircle, LogIn } from 'lucide-react';

/**
 * /collab/[sessionId] — Guest invite landing page.
 *
 * Flow:
 *   1. Validate the invite token from the URL
 *   2. Show the Host's session info
 *   3. Guest enters their name and clicks "Request to Join"
 *   4. Guest knocks → waits for Host approval
 *   5. On approval, redirect to the workspace
 */

function CollabJoinContent({ params }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');
  const sessionId = params?.sessionId;
  const autoJoinRequested = searchParams.get('join') === '1';

  const { data: authSession, status: authStatus } = useSession();
  const [state, setState] = useState('validating'); // validating | valid | knocking | admitted | denied | error
  const [sessionInfo, setSessionInfo] = useState(null);
  const [guestName, setGuestName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const autoJoinAttemptedRef = useRef(false);

  // Sync auth state from next-auth session
  useEffect(() => {
    if (authStatus === 'loading') return;
    if (authSession?.user) {
      setIsAuthenticated(true);
      setGuestName(authSession.user.name || authSession.user.email?.split('@')[0] || '');
    }
  }, [authSession, authStatus]);

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setState('error');
      setErrorMsg('Missing invite token. Please check the link.');
      return;
    }

    collabSessionService.validateToken(token).then((info) => {
      if (!info) {
        setState('error');
        setErrorMsg('This invite link is invalid or has expired.');
        return;
      }
      setSessionInfo(info);
      setState('valid');
    }).catch(() => {
      setState('error');
      setErrorMsg('Failed to validate invite link.');
    });
  }, [token]);

  // Listen for admit/deny events
  useEffect(() => {
    const unsubs = [
      collabSessionService.on('session:joined', (detail) => {
        setState('admitted');
        // Persist session info so it survives the full-page navigation
        const hostSlug = detail?.slug || sessionInfo?.slug || '';
        const resolvedSessionId = collabSessionService.sessionId || sessionId;
        const resolvedGuestId = detail?.guestId || collabSessionService._userId || '';
        const resolvedHostId = detail?.hostId || collabSessionService._hostId || '';
        const resolvedHostName = collabSessionService.session?.hostName || sessionInfo?.hostName || null;
        const resolvedPermissions = detail?.permissions || null;
        try {
          sessionStorage.setItem('synthi-pending-guest-session', JSON.stringify({
            sessionId: resolvedSessionId,
            guestId: resolvedGuestId,
            hostId: resolvedHostId,
            slug: hostSlug,
            hostName: resolvedHostName,
            permissions: resolvedPermissions,
            displayName: collabSessionService.displayName || null,
          }));
        } catch (_) {}
        // Redirect to the host's workspace after short delay
        setTimeout(() => {
          window.location.href = `/${encodeURIComponent(hostSlug)}`;
        }, 1500);
      }),
      collabSessionService.on('knock:denied', () => {
        setState('denied');
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [sessionInfo, sessionId]);

  // Handle knock
  const handleJoin = useCallback(async () => {
    if (!guestName.trim() && !isAuthenticated) return;
    setState('knocking');

    try {
      let guestId;
      let displayName;
      let avatarUrl = '';

      if (isAuthenticated) {
        guestId = authSession.user.id || authSession.user.email;
        displayName = authSession.user.name || authSession.user.email?.split('@')[0];
        avatarUrl = authSession.user.image || '';
      } else {
        // Generate a simple guest id
        guestId = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        displayName = guestName.trim();
      }

      await collabSessionService.knock(sessionInfo.sessionId, {
        guestId,
        displayName,
        avatarUrl,
      });
    } catch (e) {
      setState('error');
      setErrorMsg(e.message);
    }
  }, [authSession, guestName, isAuthenticated, sessionInfo]);

  // The login path returns to this same invite URL.  Automatically resume the
  // approved intent so an OAuth redirect never turns a valid invitation into a
  // second invitation request.
  useEffect(() => {
    if (!autoJoinRequested || !isAuthenticated || !sessionInfo || state !== 'valid' || autoJoinAttemptedRef.current) return;
    autoJoinAttemptedRef.current = true;
    handleJoin();
  }, [autoJoinRequested, handleJoin, isAuthenticated, sessionInfo, state]);

  const handleLoginToJoin = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.set('join', '1');
    const invitePath = `/collab/${encodeURIComponent(sessionId || '')}?${next.toString()}`;
    router.push(`/login?callbackUrl=${encodeURIComponent(invitePath)}`);
  }, [router, searchParams, sessionId]);

  return (
    <div className="vt-workbench-shell flex min-h-screen items-center justify-center p-4">
      <div className="vt-dialog-surface w-full max-w-md p-8">
        {/* Header */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="vt-agent-card flex h-10 w-10 items-center justify-center">
            <Users className="w-5 h-5 text-[var(--attention-purple)]" />
          </div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Join Collaboration</h1>
        </div>

        {/* Validating */}
        {state === 'validating' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="w-8 h-8 animate-spin text-[var(--attention-purple)]" />
            <p className="text-sm text-[var(--text-muted)]">Validating invite link…</p>
          </div>
        )}

        {/* Valid — show join form */}
        {state === 'valid' && sessionInfo && (
          <div className="flex flex-col gap-4">
            <div className="vt-workflow-card p-4">
              <p className="vt-panel-kicker mb-2">Session Host</p>
              <div className="flex items-center gap-3">
                {sessionInfo.hostAvatar ? (
                  <img src={sessionInfo.hostAvatar} alt="" className="w-8 h-8 rounded-full" />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--attention-purple)] text-sm font-bold text-[var(--primary-foreground)]">
                    {sessionInfo.hostName?.[0]?.toUpperCase() || 'H'}
                  </div>
                )}
                <div>
                  <p className="text-sm font-semibold text-[var(--text-primary)]">{sessionInfo.hostName}</p>
                  <p className="text-xs text-[var(--text-muted)]">Workspace: {sessionInfo.slug}</p>
                </div>
              </div>
            </div>

            <div>
              <label className="vt-panel-kicker mb-1.5 block">
                Your Name
              </label>
              <input
                type="text"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                placeholder="Enter your display name"
                className="th-input w-full rounded-[var(--radius-control)] border px-4 py-2.5 text-sm outline-none"
                autoFocus
                disabled={isAuthenticated}
              />
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                onClick={handleJoin}
                disabled={!guestName.trim() && !isAuthenticated}
                className="th-focus-ring th-btn-primary flex items-center justify-center gap-2 py-2.5 font-semibold disabled:opacity-50"
              >
                <Users className="w-4 h-4" />
                Continue as guest
              </button>
              {!isAuthenticated && (
                <button
                  type="button"
                  onClick={handleLoginToJoin}
                  className="th-focus-ring th-btn-ghost flex items-center justify-center gap-2 rounded-[var(--radius-control)] border px-4 py-2.5 text-sm font-semibold"
                >
                  <LogIn className="w-4 h-4" />
                  Log in to join
                </button>
              )}
            </div>
            {!isAuthenticated && (
              <p className="text-xs text-[var(--text-muted)]">
                Guest access is limited to this shared workspace. Logging in preserves this invitation and resumes joining after sign-in.
              </p>
            )}
          </div>
        )}

        {/* Knocking — waiting for host */}
        {state === 'knocking' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="relative">
              <div className="vt-workflow-alert flex h-16 w-16 items-center justify-center rounded-full">
                <Loader2 className="w-8 h-8 animate-spin text-[var(--accent-warning)]" />
              </div>
            </div>
            <div className="text-center">
              <p className="mb-1 text-sm font-semibold text-[var(--text-primary)]">Knock knock…</p>
              <p className="text-xs text-[var(--text-muted)]">
                Waiting for {sessionInfo?.hostName || 'the host'} to accept your request
              </p>
            </div>
          </div>
        )}

        {/* Admitted — redirecting */}
        {state === 'admitted' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <CheckCircle2 className="w-12 h-12 text-[var(--accent-success)]" />
            <div className="text-center">
              <p className="mb-1 text-sm font-semibold text-[var(--accent-success)]">You&apos;re in!</p>
              <p className="text-xs text-[var(--text-muted)]">Redirecting to the workspace…</p>
            </div>
          </div>
        )}

        {/* Denied */}
        {state === 'denied' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <XCircle className="w-12 h-12 text-[var(--accent-danger)]" />
            <div className="text-center">
              <p className="mb-1 text-sm font-semibold text-[var(--accent-danger)]">Request Denied</p>
              <p className="text-xs text-[var(--text-muted)]">
                The host did not accept your request to join.
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        {state === 'error' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <AlertTriangle className="w-12 h-12 text-[var(--accent-danger)]" />
            <div className="text-center">
              <p className="mb-1 text-sm font-semibold text-[var(--accent-danger)]">Something went wrong</p>
              <p className="text-xs text-[var(--text-muted)]">{errorMsg}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CollabJoinPage({ params }) {
  return (
    <Suspense fallback={
      <div className="vt-workbench-shell flex min-h-screen items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--attention-purple)]" />
      </div>
    }>
      <CollabJoinContent params={params} />
    </Suspense>
  );
}
