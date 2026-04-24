"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Inbox, Check, X, Mail } from 'lucide-react';
import collabSessionService from '@/services/collabSessionService';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

const MAX_TRAY_ITEMS = 25;

function fmtAgo(ts) {
  if (!ts) return '';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function eventKey(evt) {
  return (
    evt?.id
    || `${evt?.type || 'event'}:${evt?.queuedAt || 0}:${evt?.sessionId || ''}:${evt?.hostId || ''}`
  );
}

function titleForEvent(evt) {
  switch (evt?.type) {
    case 'collab-invite':
      return `${evt.hostName || 'Someone'} invited you to collaborate`;
    case 'knock:accepted':
      return 'Your join request was accepted';
    case 'knock:denied':
      return 'Your join request was denied';
    case 'session:terminated':
      return 'A session you were in has ended';
    case 'invite:revoked':
      return 'An invite was revoked';
    default:
      return evt?.type || 'Notification';
  }
}

function subtitleForEvent(evt) {
  if (evt?.slug) return `workspace: ${evt.slug}`;
  if (evt?.hostName) return evt.hostName;
  return '';
}

/**
 * MissedEventsTray — bell-style dropdown that lists events that were
 * delivered while the user was offline.  Events arrive via
 * collabSessionService's 'inbox:event' channel, each tagged with
 * queued:true + queuedAt.  Consumers can dismiss items individually or
 * clear the entire tray.
 *
 * Collab-invite events still auto-open the ShareModal (the service
 * handles that), but the tray gives the user a second chance to act on
 * them after they dismiss the modal.
 */
export default function MissedEventsTray() {
  const [events, setEvents] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unsubscribe = collabSessionService.onInboxEvent((detail) => {
      if (!detail) return;
      setEvents((prev) => {
        const k = eventKey(detail);
        if (prev.some((e) => eventKey(e) === k)) return prev; // dedupe
        const next = [detail, ...prev];
        return next.length > MAX_TRAY_ITEMS ? next.slice(0, MAX_TRAY_ITEMS) : next;
      });
    });
    return unsubscribe;
  }, []);

  const dismiss = useCallback((key) => {
    setEvents((prev) => prev.filter((e) => eventKey(e) !== key));
  }, []);

  const clearAll = useCallback(() => setEvents([]), []);

  const openInvite = useCallback((evt) => {
    // The service already persists the most recent invite in
    // _pendingInvite; asking for the popup opens ShareModal which reads
    // it.  We re-dispatch to re-trigger ShareModal if it was previously
    // dismissed.
    if (evt?.type === 'collab-invite') {
      collabSessionService.requestOpenPopup();
    }
    dismiss(eventKey(evt));
    setOpen(false);
  }, [dismiss]);

  const count = events.length;
  const hasEvents = count > 0;

  // Visible text label for accessibility.
  const buttonLabel = useMemo(() => (
    hasEvents ? `${count} missed ${count === 1 ? 'event' : 'events'}` : 'No missed events'
  ), [count, hasEvents]);

  // Don't render at all until there's something to show; keeps the
  // toolbar quiet in the common case.
  if (!hasEvents) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative flex items-center gap-1 px-2 py-1 rounded-lg
                     bg-[#3b82f612] border border-[#3b82f630]
                     hover:bg-[#3b82f620] transition-all"
          title={buttonLabel}
          aria-label={buttonLabel}
        >
          <Inbox className="w-3.5 h-3.5 text-[#3b82f6]" />
          <span className="text-[11px] font-bold text-[#3b82f6]">{count}</span>
          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#3b82f6] rounded-full animate-pulse" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[320px] p-3 shadow-xl rounded-xl border"
        style={{ backgroundColor: 'var(--bg-elevated)', borderColor: 'var(--border-medium)' }}
        align="end"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold flex items-center gap-1.5 text-[#3b82f6]">
            <Mail className="w-3.5 h-3.5" />
            Missed while offline
          </div>
          <button
            onClick={clearAll}
            className="text-[10px] px-1.5 py-0.5 rounded hover:bg-white/5 transition-colors"
            style={{ color: 'var(--text-muted)' }}
            title="Clear all"
          >
            Clear all
          </button>
        </div>

        <div className="space-y-2 max-h-[320px] overflow-y-auto">
          {events.map((evt) => {
            const k = eventKey(evt);
            const isInvite = evt.type === 'collab-invite';
            return (
              <div
                key={k}
                className="flex items-start gap-2 p-2 border rounded-lg"
                style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {titleForEvent(evt)}
                  </div>
                  <div className="text-[10px] flex items-center gap-1.5 mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    <span>{fmtAgo(evt.queuedAt)}</span>
                    {subtitleForEvent(evt) && <span>·</span>}
                    {subtitleForEvent(evt) && <span className="truncate">{subtitleForEvent(evt)}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {isInvite && (
                    <button
                      onClick={() => openInvite(evt)}
                      className="p-1 rounded bg-[#4ade8020] hover:bg-[#4ade8030] transition-colors"
                      title="Open invite"
                    >
                      <Check className="w-3.5 h-3.5 text-[#4ade80]" />
                    </button>
                  )}
                  <button
                    onClick={() => dismiss(k)}
                    className="p-1 rounded bg-[#ff575720] hover:bg-[#ff575730] transition-colors"
                    title="Dismiss"
                  >
                    <X className="w-3.5 h-3.5 text-[#ff5757]" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
