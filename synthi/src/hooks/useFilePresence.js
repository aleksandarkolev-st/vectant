"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import collabClient from '@/services/collabClient';

/**
 * useFilePresence — tracks which users are editing each open file.
 * Returns a Map<filePath, Array<{ userId, name, color, image }>>
 * that updates whenever awareness changes across the workspace.
 *
 * @param {string} slug - workspace slug
 * @param {string|null} myUserId - current user's id to exclude from results
 * @returns {{ presenceByFile: Object.<string, Array> }}
 */
export function useFilePresence(slug, myUserId) {
  const [presenceByFile, setPresenceByFile] = useState({});
  const snapshotRef = useRef(''); // JSON snapshot to avoid unnecessary re-renders

  const computePresence = useCallback(() => {
    if (!slug) return;

    const prefix = `workspace:${slug}:`;
    const fileMap = {}; // filePath -> [{userId, name, color, image}]

    for (const [key, entry] of collabClient.docs.entries()) {
      if (!key.startsWith(prefix)) continue;
      if (!entry.provider?.awareness) continue;

      // Extract file path from key: workspace:<slug>:user:<userId>:<filePath>
      // or the older format workspace:<slug>:<filePath>
      let filePath = null;
      const afterPrefix = key.slice(prefix.length);
      if (afterPrefix.startsWith('user:')) {
        // workspace:<slug>:user:<userId>:<filePath>
        const parts = afterPrefix.split(':');
        // parts[0]='user', parts[1]=userId, parts[2..]=filePath parts
        filePath = parts.slice(2).join(':');
      } else {
        filePath = afterPrefix;
      }
      if (!filePath) continue;

      const states = entry.provider.awareness.getStates();
      const users = [];

      states.forEach((state, clientId) => {
        if (!state?.user) return;
        const userId = String(state.user.id || clientId);
        if (userId === myUserId) return;
        // Only include users with recent activity
        if (!state.cursor && !state.lastActive) return;

        users.push({
          userId,
          name: state.user.name || 'Anonymous',
          color: state.user.color || '#4aba9a',
          image: state.user.image || null,
        });
      });

      if (users.length > 0) {
        // Merge with existing entries for this path (from multiple rooms)
        if (!fileMap[filePath]) fileMap[filePath] = [];
        for (const u of users) {
          if (!fileMap[filePath].some(e => e.userId === u.userId)) {
            fileMap[filePath].push(u);
          }
        }
      }
    }

    // Only update state if the data actually changed
    const snapshot = JSON.stringify(fileMap);
    if (snapshot !== snapshotRef.current) {
      snapshotRef.current = snapshot;
      setPresenceByFile(fileMap);
    }
  }, [slug, myUserId]);

  useEffect(() => {
    if (!slug) return;

    const unsub = collabClient.addWorkspaceAwarenessListener(slug, () => {
      computePresence();
    });

    // Initial computation
    computePresence();

    // Also poll in case some awareness listeners aren't perfectly wired
    const interval = setInterval(computePresence, 3000);

    return () => {
      unsub();
      clearInterval(interval);
    };
  }, [slug, computePresence]);

  return { presenceByFile };
}
