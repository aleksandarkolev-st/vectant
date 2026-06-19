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

const TRAY_SHELL_STYLE = {
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 94%, #0b0c14), var(--bg-panel))',
  borderColor: 'color-mix(in srgb, var(--border-medium) 84%, var(--accent-primary) 16%)',
  boxShadow: '0 18px 44px rgba(0,0,0,0.42), 0 0 0 1px rgba(255,255,255,0.025)',
};

const TRAY_BUTTON_STYLE = {
  color: 'var(--text-secondary)',
  background: 'color-mix(in srgb, var(--bg-surface) 86%, var(--accent-primary) 5%)',
  border: '1px solid var(--border-subtle)',
};

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

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={
            hasEvents
              ? 'relative flex items-center gap-1 px-2 py-1 rounded-lg border transition-all'
              : 'relative flex items-center gap-1 px-2 py-1 rounded-lg border border-transparent hover:bg-white/5 transition-all'
          }
          title={buttonLabel}
          aria-label={buttonLabel}
          style={hasEvents
            ? {
                color: 'var(--accent-tertiary)',
                background: 'color-mix(in srgb, var(--accent-primary) 13%, transparent)',
                borderColor: 'color-mix(in srgb, var(--accent-primary) 32%, transparent)',
              }
            : { color: 'var(--text-muted)' }}
        >
          <Inbox className="w-3.5 h-3.5" />
          {hasEvents && (
            <>
              <span className="text-[11px] font-bold">{count}</span>
              <span
                className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full animate-pulse"
                style={{ background: 'var(--accent-success)' }}
              />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[340px] p-0 rounded-[10px] border overflow-hidden"
        style={TRAY_SHELL_STYLE}
        align="end"
      >
        <div className="h-px w-full" style={{ background: 'var(--brand-gradient-horizontal)' }} />
        <div className="flex items-start justify-between gap-3 p-3.5 pb-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <span
                className="w-6 h-6 rounded-md grid place-items-center border"
                style={{
                  borderColor: 'color-mix(in srgb, var(--accent-primary) 35%, var(--border-subtle))',
                  background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                  color: 'var(--accent-tertiary)',
                }}
              >
                <Mail className="w-3.5 h-3.5" />
              </span>
              Offline inbox
              {hasEvents && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-md font-medium"
                  style={{
                    color: 'var(--text-muted)',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                  }}
                >
                  {count}
                </span>
              )}
            </div>
            <div className="text-[10px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
              Collaboration events captured while this client was away.
            </div>
          </div>
          {hasEvents && (
            <button
              onClick={clearAll}
              className="text-[10px] px-2 py-1 rounded-md transition-colors"
              style={TRAY_BUTTON_STYLE}
              title="Clear all"
            >
              Clear all
            </button>
          )}
        </div>

        {!hasEvents && (
          <div
            className="flex flex-col items-center justify-center py-8 mx-3.5 my-3.5 text-center rounded-lg border"
            style={{
              color: 'var(--text-muted)',
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--bg-surface) 72%, transparent)',
            }}
          >
            <Inbox className="w-6 h-6 mb-2 opacity-60" />
            <div className="text-xs font-medium">All caught up</div>
            <div className="text-[10px] mt-1 opacity-80">
              Invites and sync changes will appear here when you reconnect.
            </div>
          </div>
        )}

        <div className="space-y-1.5 max-h-[320px] overflow-y-auto p-3.5">
          {events.map((evt) => {
            const k = eventKey(evt);
            const isInvite = evt.type === 'collab-invite';
            return (
              <div
                key={k}
                className="flex items-start gap-2 p-2.5 border rounded-[8px]"
                style={{
                  background: 'var(--bg-surface)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <span
                  className="mt-1 h-2 w-2 rounded-full shrink-0"
                  style={{
                    background: isInvite ? 'var(--accent-success)' : 'var(--accent-primary)',
                    boxShadow: `0 0 0 3px color-mix(in srgb, ${isInvite ? 'var(--accent-success)' : 'var(--accent-primary)'} 18%, transparent)`,
                  }}
                  aria-hidden
                />
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
                      className="p-1 rounded-md transition-colors border"
                      style={{
                        color: 'var(--accent-success)',
                        background: 'color-mix(in srgb, var(--accent-success) 12%, transparent)',
                        borderColor: 'color-mix(in srgb, var(--accent-success) 24%, transparent)',
                      }}
                      title="Open invite"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => dismiss(k)}
                    className="p-1 rounded-md transition-colors border"
                    style={{
                      color: 'var(--text-muted)',
                      background: 'var(--bg-panel)',
                      borderColor: 'var(--border-subtle)',
                    }}
                    title="Dismiss"
                  >
                    <X className="w-3.5 h-3.5" />
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
