"use client";

import { useState, useEffect, useRef } from 'react';
import collabClient from '@/services/collabClient';

/**
 * React hook that returns the list of active users for a workspace
 * by subscribing to the workspace-level awareness aggregation.
 *
 * Each entry: { clientId, user: { id, name, color, image } }
 *
 * @param {string} slug - workspace slug
 * @returns {Array<{ clientId: number, user: { id: string, name: string, color: string, image: string|null } }>}
 */
export function usePresence(slug) {
  const [users, setUsers] = useState([]);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  useEffect(() => {
    if (!slug) { setUsers([]); return; }

    // Seed with current snapshot
    const initial = collabClient.getWorkspaceActiveEditors(slug);
    setUsers(normalize(initial));

    // Subscribe to changes
    const unsub = collabClient.addWorkspaceAwarenessListener(slug, (editors) => {
      setUsers(normalize(editors));
    });

    return unsub;
  }, [slug]);

  return users;
}

/**
 * Normalize raw awareness entries into a clean user list.
 * Deduplicates by user.id and picks the best avatar/name.
 */
function normalize(entries) {
  if (!entries || entries.length === 0) return [];
  const seen = new Map();
  for (const { clientId, state } of entries) {
    const u = state?.user;
    if (!u) continue;
    const id = u.id || String(clientId);
    // prefer the entry with more info (image, name)
    const prev = seen.get(id);
    if (!prev || (!prev.user.image && u.image)) {
      seen.set(id, {
        clientId,
        user: {
          id,
          name: u.name || 'Anonymous',
          color: u.color || '#888',
          image: u.image || null,
        },
      });
    }
  }
  return Array.from(seen.values());
}
