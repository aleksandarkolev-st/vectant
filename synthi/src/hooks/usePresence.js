"use client";

import { useState, useEffect, useRef } from 'react';
import collabClient from '@/services/collabClient';

/**
 * React hook that returns the list of active users for a workspace
 * by subscribing to the workspace-level awareness aggregation.
 *
 * Each entry: { clientId, user: { id, name, color, image, activeFile } }
 *
 * `activeFile` is the path of the file the user is most recently active in,
 * derived from the awareness room key. May be null when unknown.
 *
 * @param {string} slug - workspace slug
 * @returns {Array<{ clientId: number, user: { id: string, name: string, color: string, image: string|null, activeFile: string|null } }>}
 */
export function usePresence(slug) {
  const [users, setUsers] = useState([]);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  useEffect(() => {
    if (!slug) { setUsers([]); return; }

    // Seed with current snapshot
    const initial = collabClient.getWorkspaceActiveEditors(slug);
    setUsers(normalize(initial, slug));

    // Subscribe to changes
    const unsub = collabClient.addWorkspaceAwarenessListener(slug, (editors) => {
      setUsers(normalize(editors, slug));
    });

    return unsub;
  }, [slug]);

  return users;
}

/**
 * Awareness room keys take one of two shapes (see collabClient._roomKey):
 *   workspace:<slug>:user:<encodedUserId>:<path>
 *   workspace:<slug>:legacy-denied:<path>
 *
 * The trailing path segment is the file the user has open. We return null
 * for the synthetic 'root' path used when no file is bound.
 */
function parseActiveFile(key, slug) {
  if (!key || !slug) return null;
  const prefix = `workspace:${slug}:`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (rest.startsWith('user:')) {
    const after = rest.slice('user:'.length);
    const colon = after.indexOf(':');
    if (colon === -1) return null;
    const path = after.slice(colon + 1);
    return path && path !== 'root' ? path : null;
  }
  if (rest.startsWith('legacy-denied:')) {
    const path = rest.slice('legacy-denied:'.length);
    return path && path !== 'root' ? path : null;
  }
  return null;
}

/**
 * Normalize raw awareness entries into a clean user list.
 * Deduplicates by user.id and picks the best avatar/name.
 */
function normalize(entries, slug) {
  if (!entries || entries.length === 0) return [];
  const seen = new Map();
  for (const { clientId, state, key } of entries) {
    const u = state?.user;
    if (!u) continue;
    const id = u.id || String(clientId);
    const activeFile = parseActiveFile(key, slug);
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
          activeFile,
        },
      });
    } else if (!prev.user.activeFile && activeFile) {
      // Fill in an activeFile we didn't have before without disturbing the rest
      prev.user.activeFile = activeFile;
    }
  }
  return Array.from(seen.values());
}
