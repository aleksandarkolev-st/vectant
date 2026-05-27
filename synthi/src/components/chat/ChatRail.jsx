'use client';

/**
 * ChatRail — the "Rail + Stream" rail (wide surfaces only). Slide-in overlay
 * drawer, collapsed by default, pinned until the collapse control or scrim is
 * clicked. Holds the session list + New chat, and a footer slot for the
 * workspace diagnostics/context drawer.
 *
 * Selecting a session or starting a new chat collapses the rail so focus
 * returns to the conversation. The orb mark is a static gradient square here;
 * the single live WebGL orb is hoisted + animated in step 4.
 */
import { X, Plus, MessageSquare } from 'lucide-react';

export default function ChatRail({
  open,
  onClose,
  sessions = [],
  activeId,
  onSelect,
  onNew,
  onCloseSession,
  children,
}) {
  return (
    <>
      <div
        className={`vx-rail-scrim ${open ? 'is-open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={`vx-rail ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <div className="vx-rail-head">
          <span className="vx-rail-orb" aria-hidden="true" />
          <span className="vx-rail-name">Vectant AI</span>
          <button
            type="button"
            className="vx-rail-collapse th-focus-ring"
            onClick={onClose}
            title="Collapse"
            aria-label="Collapse rail"
          >
            <X className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
        </div>

        <button
          type="button"
          className="vx-rail-new"
          onClick={() => { onNew?.(); onClose?.(); }}
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2} /> New chat
        </button>

        <div className="vx-rail-sec">Chats</div>
        <div className="vx-rail-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`vx-rail-row ${s.id === activeId ? 'is-active' : ''}`}
              onClick={() => { onSelect?.(s.id); onClose?.(); }}
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

        {children ? <div className="vx-rail-foot">{children}</div> : null}
      </aside>
    </>
  );
}
