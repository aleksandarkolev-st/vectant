"use client";

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import collabSessionService from '@/services/collabSessionService';
import { Users, Loader2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { getCurrentUser } from '@/services/userIdentity';

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
  const token = searchParams.get('token');
  const sessionId = params?.sessionId;

  const [state, setState] = useState('validating'); // validating | valid | knocking | admitted | denied | error
  const [sessionInfo, setSessionInfo] = useState(null);
  const [guestName, setGuestName] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setState('error');
      setErrorMsg('Missing invite token. Please check the link.');
      return;
    }

    const user = getCurrentUser();
    if (user && user.id !== 'guest') {
      setIsAuthenticated(true);
      setGuestName(user.name);
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
      collabSessionService.on('session:joined', () => {
        setState('admitted');
        // Redirect to workspace after short delay
        setTimeout(() => {
          window.location.href = `/workspace/${sessionInfo?.slug || ''}`;
        }, 1500);
      }),
      collabSessionService.on('knock:denied', () => {
        setState('denied');
      }),
    ];
    return () => unsubs.forEach(fn => fn());
  }, [sessionInfo]);

  // Handle knock
  const handleJoin = async () => {
    if (!guestName.trim() && !isAuthenticated) return;
    setState('knocking');

    try {
      let guestId;
      let displayName;
      let avatarUrl = '';

      if (isAuthenticated) {
        const user = getCurrentUser();
        guestId = user.id;
        displayName = user.name;
        avatarUrl = user.avatar;
      } else {
        // Generate a simple guest id
        guestId = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        displayName = guestName.trim();
        localStorage.setItem('synthi-user-id', guestId);
        localStorage.setItem('synthi-user-name', displayName);
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
  };

  return (
    <div className="min-h-screen bg-[#08090d] flex items-center justify-center p-4">
      <div className="bg-[#0d0e14] border border-[#1a1b24] rounded-2xl shadow-2xl p-8 w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-[#3a857420] flex items-center justify-center">
            <Users className="w-5 h-5 text-[#3a8574]" />
          </div>
          <h1 className="text-xl font-bold text-[#e0e4ec]">Join Collaboration</h1>
        </div>

        {/* Validating */}
        {state === 'validating' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="w-8 h-8 text-[#3a8574] animate-spin" />
            <p className="text-sm text-[#5a6178]">Validating invite link…</p>
          </div>
        )}

        {/* Valid — show join form */}
        {state === 'valid' && sessionInfo && (
          <div className="flex flex-col gap-4">
            <div className="bg-[#101118] border border-[#1a1b24] rounded-xl p-4">
              <p className="text-xs text-[#5a6178] uppercase tracking-wider mb-2">Session Host</p>
              <div className="flex items-center gap-3">
                {sessionInfo.hostAvatar ? (
                  <img src={sessionInfo.hostAvatar} alt="" className="w-8 h-8 rounded-full" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-[#3a8574] flex items-center justify-center text-white text-sm font-bold">
                    {sessionInfo.hostName?.[0]?.toUpperCase() || 'H'}
                  </div>
                )}
                <div>
                  <p className="text-sm font-semibold text-[#e0e4ec]">{sessionInfo.hostName}</p>
                  <p className="text-xs text-[#5a6178]">Workspace: {sessionInfo.slug}</p>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#5a6178] font-medium mb-1.5 uppercase tracking-wider">
                Your Name
              </label>
              <input
                type="text"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
                placeholder="Enter your display name"
                className="w-full bg-[#101118] border border-[#1a1b24] focus:border-[#3a8574] rounded-lg px-4 py-2.5 text-sm text-[#e0e4ec] placeholder-[#5a6178] outline-none transition-colors"
                autoFocus
                disabled={isAuthenticated}
              />
            </div>

            <button
              onClick={handleJoin}
              disabled={!guestName.trim() && !isAuthenticated}
              className="w-full py-2.5 bg-[#3a8574] hover:bg-[#327464] disabled:bg-[#1a1b24] disabled:text-[#5a6178] text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <Users className="w-4 h-4" />
              Request to Join
            </button>
          </div>
        )}

        {/* Knocking — waiting for host */}
        {state === 'knocking' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-[#fbbf2410] border-2 border-[#fbbf24] flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-[#fbbf24] animate-spin" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-[#e0e4ec] mb-1">Knock knock…</p>
              <p className="text-xs text-[#5a6178]">
                Waiting for {sessionInfo?.hostName || 'the host'} to accept your request
              </p>
            </div>
          </div>
        )}

        {/* Admitted — redirecting */}
        {state === 'admitted' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <CheckCircle2 className="w-12 h-12 text-[#4ade80]" />
            <div className="text-center">
              <p className="text-sm font-semibold text-[#4ade80] mb-1">You&apos;re in!</p>
              <p className="text-xs text-[#5a6178]">Redirecting to the workspace…</p>
            </div>
          </div>
        )}

        {/* Denied */}
        {state === 'denied' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <XCircle className="w-12 h-12 text-[#ff5757]" />
            <div className="text-center">
              <p className="text-sm font-semibold text-[#ff5757] mb-1">Request Denied</p>
              <p className="text-xs text-[#5a6178]">
                The host did not accept your request to join.
              </p>
            </div>
          </div>
        )}

        {/* Error */}
        {state === 'error' && (
          <div className="flex flex-col items-center gap-4 py-8">
            <AlertTriangle className="w-12 h-12 text-[#ff5757]" />
            <div className="text-center">
              <p className="text-sm font-semibold text-[#ff5757] mb-1">Something went wrong</p>
              <p className="text-xs text-[#5a6178]">{errorMsg}</p>
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
      <div className="min-h-screen bg-[#08090d] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-[#3a8574] animate-spin" />
      </div>
    }>
      <CollabJoinContent params={params} />
    </Suspense>
  );
}
