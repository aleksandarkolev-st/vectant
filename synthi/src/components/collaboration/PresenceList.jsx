"use client";

import { useMemo } from 'react';
import { usePresence } from '@/hooks/usePresence';

/**
 * PresenceList – Google-Docs-style horizontal avatar bar.
 *
 * Renders a compact row of circular avatars (image or initials) with a
 * coloured border matching each user's awareness colour and a tooltip
 * showing their display name.
 *
 * Designed to sit in the StatusBar or workspace header.
 */
export default function PresenceList({ slug, maxVisible = 5 }) {
  const users = usePresence(slug);

  // Limit how many we render inline; overflow gets a "+N" pill
  const visible = useMemo(() => users.slice(0, maxVisible), [users, maxVisible]);
  const overflow = users.length - visible.length;

  if (users.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5">
      {visible.map((entry) => (
        <Avatar key={entry.user.id} user={entry.user} />
      ))}
      {overflow > 0 && (
        <span
          className="flex items-center justify-center w-6 h-6 rounded-full
                     bg-[#1a1b24] text-[10px] font-semibold text-[#9ba2b8]
                     border border-[#2a2b38] ml-0.5 select-none"
          title={`${overflow} more user${overflow > 1 ? 's' : ''}`}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

/** Single circular avatar with coloured border ring. */
function Avatar({ user }) {
  const { name, color, image } = user;
  const initials = getInitials(name);

  return (
    <div
      className="relative group flex-shrink-0"
      title={name}
    >
      {/* Coloured ring */}
      <div
        className="w-6 h-6 rounded-full flex items-center justify-center
                   border-2 overflow-hidden"
        style={{ borderColor: color }}
      >
        {image ? (
          <img
            src={image}
            alt={name}
            className="w-full h-full rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            className="text-[9px] font-bold leading-none select-none"
            style={{ color }}
          >
            {initials}
          </span>
        )}
      </div>

      {/* Tooltip — appears on hover */}
      <div
        className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2
                   mb-1.5 px-2 py-0.5 rounded text-[10px] font-medium whitespace-nowrap
                   bg-[#1a1b24] text-[#e0e2ea] border border-[#2a2b38]
                   opacity-0 group-hover:opacity-100 transition-opacity z-50"
      >
        {name}
      </div>
    </div>
  );
}

/** Extract up to two initials from a display name. */
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
