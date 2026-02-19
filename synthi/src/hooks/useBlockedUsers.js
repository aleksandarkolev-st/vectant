"use client";

import { useState, useEffect, useCallback } from 'react';
import collabSessionService from '@/services/collabSessionService';

/**
 * React hook for managing the current user's block list.
 *
 * @returns {{ blockedUsers: string[], blockUser: (id: string) => Promise, unblockUser: (id: string) => Promise, isBlocked: (id: string) => boolean, loading: boolean }}
 */
export function useBlockedUsers() {
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fetch initial list
  useEffect(() => {
    let mounted = true;
    collabSessionService.getBlockedList().then((list) => {
      if (mounted) {
        setBlockedUsers(list);
        setLoading(false);
      }
    }).catch(() => {
      if (mounted) setLoading(false);
    });

    // Refresh on block:changed events
    const unsub = collabSessionService.on('block:changed', () => {
      collabSessionService.getBlockedList().then((list) => {
        if (mounted) setBlockedUsers(list);
      }).catch(() => {});
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  const blockUser = useCallback(async (userId) => {
    await collabSessionService.blockUser(userId);
    setBlockedUsers(prev => prev.includes(userId) ? prev : [...prev, userId]);
  }, []);

  const unblockUser = useCallback(async (userId) => {
    await collabSessionService.unblockUser(userId);
    setBlockedUsers(prev => prev.filter(id => id !== userId));
  }, []);

  const isBlocked = useCallback((userId) => {
    return blockedUsers.includes(userId);
  }, [blockedUsers]);

  return { blockedUsers, blockUser, unblockUser, isBlocked, loading };
}
