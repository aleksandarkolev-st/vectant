'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MASK = 'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)';

/**
 * Horizontal chip strip with the navbar tab-strip scrollbar: native bar hidden,
 * a custom 3px draggable thumb in its own lane, edge-fade mask, and wheel-up/down
 * → scroll left/right. items: [{id, label}]. Controlled via activeId/onSelect.
 */
export default function FilterStrip({ items = [], activeId, onSelect }) {
  const scrollerRef = useRef(null);
  const thumbRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);

  const updateThumb = useCallback(() => {
    const el = scrollerRef.current;
    const thumb = thumbRef.current;
    if (!el || !thumb) return;
    const { scrollWidth, clientWidth, scrollLeft } = el;
    if (scrollWidth <= clientWidth + 1) { thumb.style.display = 'none'; return; }
    const thumbWidth = Math.max(24, (clientWidth / scrollWidth) * clientWidth);
    const maxScroll = scrollWidth - clientWidth;
    const maxThumb = clientWidth - thumbWidth;
    thumb.style.display = 'block';
    thumb.style.width = `${thumbWidth}px`;
    thumb.style.transform = `translateX(${maxScroll > 0 ? (scrollLeft / maxScroll) * maxThumb : 0}px)`;
  }, []);

  useLayoutEffect(() => { updateThumb(); }, [items, updateThumb]);

  // Vertical wheel → horizontal scroll (the editor strip lacks this; add it here).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onThumbDown = useCallback((e) => {
    const el = scrollerRef.current;
    const thumb = thumbRef.current;
    if (!el || !thumb) return;
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startLeft = el.scrollLeft;
    const { scrollWidth, clientWidth } = el;
    const maxScroll = scrollWidth - clientWidth;
    const maxThumb = clientWidth - thumb.offsetWidth;
    const move = (ev) => { el.scrollLeft = startLeft + (maxThumb > 0 ? ((ev.clientX - startX) / maxThumb) * maxScroll : 0); };
    const up = () => { setDragging(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);

  return (
    <div className="relative" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="overflow-hidden" style={{ maskImage: MASK, WebkitMaskImage: MASK }}>
        <div
          ref={scrollerRef}
          data-testid="filter-scroller"
          onScroll={updateThumb}
          className="flex gap-1.5 overflow-x-auto no-scrollbar py-0.5"
          style={{ scrollbarWidth: 'none' }}
        >
          {items.map((it) => {
            const active = it.id === activeId;
            return (
              <button
                key={it.id}
                type="button"
                data-testid={`filter-chip-${it.id}`}
                aria-pressed={active}
                onClick={() => onSelect?.(it.id)}
                className="shrink-0 whitespace-nowrap cursor-pointer"
                style={{
                  fontSize: '10px',
                  borderRadius: '7px',
                  padding: '4px 10px',
                  color: active ? '#e8e6ff' : 'var(--text-secondary)',
                  border: `1px solid ${active ? 'var(--border-medium)' : 'var(--border-subtle)'}`,
                  background: active
                    ? 'linear-gradient(90deg, rgba(162,61,255,0.22), rgba(61,109,255,0.22))'
                    : 'transparent',
                }}
              >
                {it.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="pointer-events-none absolute left-0 right-0 h-[3px]" style={{ bottom: '-3px' }}>
        <div
          ref={thumbRef}
          onMouseDown={onThumbDown}
          className="pointer-events-auto absolute inset-y-0 left-0 rounded-[3px] cursor-pointer"
          style={{
            display: 'none',
            background: 'linear-gradient(90deg, color-mix(in srgb, var(--brand-stop-3) 35%, transparent), color-mix(in srgb, var(--brand-stop-4) 35%, transparent))',
            opacity: hovered || dragging ? 1 : 0,
            transition: 'opacity 0.2s ease',
          }}
        />
      </div>
    </div>
  );
}
