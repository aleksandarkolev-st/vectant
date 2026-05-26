'use client';

/**
 * ChatSessionDropdown — the narrow-surface session switcher that replaces the
 * rail in the header. Shows the active chat's title; opens a menu with all
 * sessions + New chat. Controlled-open so it closes on selection.
 */
import { useState } from 'react';
import { ChevronDown, Plus, X, MessageSquare } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export default function ChatSessionDropdown({ sessions = [], activeId, onSelect, onNew, onCloseSession }) {
  const [open, setOpen] = useState(false);
  const active = sessions.find((s) => s.id === activeId) || sessions[0];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="vx-sessdd th-focus-ring" title="Switch chat">
          <span className="truncate" style={{ maxWidth: 130 }}>{active?.title || 'Chat'}</span>
          <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        className="w-60 p-1.5"
        style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-medium)' }}
      >
        <button
          type="button"
          className="vx-sessdd-new"
          onClick={() => { onNew?.(); setOpen(false); }}
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2} /> New chat
        </button>
        <div className="vx-rail-sec">Chats</div>
        <div className="vx-rail-list" style={{ maxHeight: 220 }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`vx-rail-row ${s.id === activeId ? 'is-active' : ''}`}
              onClick={() => { onSelect?.(s.id); setOpen(false); }}
            >
              <MessageSquare className="w-3.5 h-3.5" strokeWidth={2} />
              <span className="truncate flex-1">{s.title}</span>
              {sessions.length > 1 && (
                <span
                  role="button"
                  tabIndex={0}
                  className="vx-rail-rowclose"
                  title="Close chat"
                  onClick={(e) => { e.stopPropagation(); onCloseSession?.(s.id); }}
                >
                  <X className="w-3 h-3" strokeWidth={2} />
                </span>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
