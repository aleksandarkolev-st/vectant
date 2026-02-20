"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import collabSessionService from '@/services/collabSessionService';
import { getCurrentUser } from '@/services/userIdentity';

/**
 * React hook for managing a collaboration session.
 *
 * Provides the full session state and actions for both Host and Guest roles.
 *
 * @returns {Object} Session state and action dispatchers
 */
export function useCollabSession() {
  const [role, setRole] = useState(collabSessionService.role);
  const [session, setSession] = useState(collabSessionService.session);
  const [permissions, setPermissions] = useState(collabSessionService.permissions);
  const [pendingKnocks, setPendingKnocks] = useState(collabSessionService.pendingKnocks);
  const [guests, setGuests] = useState([]);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hostId, setHostId] = useState(collabSessionService.hostId);
  const [effectiveUserId, setEffectiveUserId] = useState(collabSessionService.effectiveUserId);
  const [wsStatus, setWsStatus] = useState(collabSessionService.wsStatus);

  // Sync state on every change event
  useEffect(() => {
    const refresh = async () => {
      setRole(collabSessionService.role);
      setSession(collabSessionService.session);
      setPermissions(collabSessionService.permissions);
      setPendingKnocks(collabSessionService.pendingKnocks);
      setHostId(collabSessionService.hostId);
      setEffectiveUserId(collabSessionService.effectiveUserId);
      setWsStatus(collabSessionService.wsStatus);

      // Fetch full session info for guest list
      if (collabSessionService.isActive) {
        const info = await collabSessionService.refreshSession().catch(() => null);
        if (info?.guests) setGuests(info.guests);
      } else {
        setGuests([]);
      }
    };

    return collabSessionService.onChange((detail) => {
      refresh();
    });
  }, []);

  // ── Host actions ─────────────────────────────────────────────────────────

  const createSession = useCallback(async (opts) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await collabSessionService.createSession(opts);
      return data;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const admitGuest = useCallback(async (guestId, opts = {}) => {
    try {
      // Find the knock info for display name
      const knock = pendingKnocks.find(k => k.guestId === guestId);
      return await collabSessionService.admitGuest(guestId, {
        displayName: knock?.displayName || guestId,
        avatarUrl: knock?.avatarUrl || '',
        ...opts,
      });
    } catch (e) {
      setError(e.message);
    }
  }, [pendingKnocks]);

  const denyKnock = useCallback(async (guestId) => {
    try {
      await collabSessionService.denyKnock(guestId);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const updatePermissions = useCallback(async (guestId, perms) => {
    try {
      return await collabSessionService.updatePermissions(guestId, perms);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const kickGuest = useCallback(async (guestId) => {
    try {
      await collabSessionService.kickGuest(guestId);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const terminateSession = useCallback(async () => {
    try {
      await collabSessionService.terminateSession();
    } catch (e) {
      setError(e.message);
    }
  }, []);

  const regenerateInvite = useCallback(async () => {
    try {
      return await collabSessionService.regenerateInvite();
    } catch (e) {
      setError(e.message);
    }
  }, []);

  // ── Guest actions ────────────────────────────────────────────────────────

  const joinViaToken = useCallback(async (token, guestInfo) => {
    setIsLoading(true);
    setError(null);
    try {
      const info = await collabSessionService.validateToken(token);
      if (!info) throw new Error('Invalid or expired invite link');
      await collabSessionService.knock(info.sessionId, guestInfo);
      return info;
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const leaveSession = useCallback(() => {
    collabSessionService.leaveSession();
  }, []);

  const requestJoinSession = useCallback(async (sessionId) => {
    setIsLoading(true);
    setError(null);
    try {
      const { id: userId, name: userName, avatar: userAvatar } = getCurrentUser();
      await collabSessionService.requestJoinSession(sessionId, {
        guestId: userId,
        displayName: userName,
        avatarUrl: userAvatar,
      });
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ── Direct Collaboration actions ─────────────────────────────────────

  /**
   * Ask to join a specific user's workspace (no pre-existing session needed).
   */
  const joinUser = useCallback(async (targetUserId, targetUserName, slug) => {
    setIsLoading(true);
    setError(null);
    try {
      const { id: guestId, name: displayName, avatar: avatarUrl } = getCurrentUser();
      return await collabSessionService.joinUser({
        targetUserId,
        targetUserName,
        slug,
        guestId,
        displayName,
        avatarUrl,
      });
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Invite another user to join YOUR workspace (auto-creates session).
   */
  const inviteUser = useCallback(async (targetUserId, slug) => {
    setIsLoading(true);
    setError(null);
    try {
      const { id: hostId, name: hostName, avatar: hostAvatar } = getCurrentUser();
      return await collabSessionService.inviteUser({
        targetUserId,
        hostId,
        hostName,
        hostAvatar,
        slug,
      });
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Join a session using a short room code.
   */
  const joinByCode = useCallback(async (code) => {
    setIsLoading(true);
    setError(null);
    try {
      const { id: guestId, name: displayName, avatar: avatarUrl } = getCurrentUser();
      return await collabSessionService.joinByCode({
        code,
        guestId,
        displayName,
        avatarUrl,
      });
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    // State
    role,
    session,
    permissions,
    pendingKnocks,
    guests,
    error,
    isLoading,
    isHost: role === 'hosting',
    isGuest: role === 'guest',
    isActive: role === 'hosting' || role === 'guest',
    isKnocking: role === 'knocking',
    hostId,
    effectiveUserId,
    wsStatus,
    sessionSlug: collabSessionService.sessionSlug,

    // Host actions
    createSession,
    admitGuest,
    denyKnock,
    updatePermissions,
    kickGuest,
    terminateSession,
    regenerateInvite,

    // Guest actions
    joinViaToken,
    leaveSession,
    requestJoinSession,

    // Direct collaboration
    joinUser,
    inviteUser,
    joinByCode,

    // Clear error
    clearError: () => setError(null),
  };
}

/**
 * Lightweight hook that only tracks the current user's permissions.
 * Useful for components that need to conditionally disable UI.
 *
 * @returns {import('@/services/collabSessionService').GuestPermissions & { role: string }}
 */
export function useSessionPermissions() {
  const [permissions, setPermissions] = useState(collabSessionService.permissions);
  const [role, setRole] = useState(collabSessionService.role);

  useEffect(() => {
    return collabSessionService.onChange(() => {
      setPermissions(collabSessionService.permissions);
      setRole(collabSessionService.role);
    });
  }, []);

  return { ...permissions, role };
}
