"use client";

import { useState, useEffect } from 'react';
import collabClient from '@/services/collabClient';

/**
 * React hook that returns the aggregated collaboration WebSocket status.
 *
 * @returns {'connected'|'connecting'|'disconnected'} current status
 */
export function useCollabStatus() {
  const [status, setStatus] = useState(collabClient.connectionStatus);

  useEffect(() => {
    // Sync on mount in case it changed before the listener was attached
    setStatus(collabClient.connectionStatus);
    return collabClient.onStatusChange(setStatus);
  }, []);

  return status;
}
