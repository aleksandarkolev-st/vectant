# Programs Panel UI/UX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Programs panel as a Library-first sidebar (hybrid running cards + idle launch tiles) with an in-sidebar Store view (scroll-fade filter strip + 2-up tiles), in the vectant design language.

**Architecture:** `ProgramsPanel` becomes a thin **shell** that owns data + handlers + a `view` state (`'library' | 'store'`) and renders either `<LibraryView>` or `<StoreView>`. All existing data loading, docking integration (`openProgramSession`), and action handlers stay in the shell and pass down as props. Presentational pieces are new focused components. The Store filter strip replicates `EditorTabStrip`'s scrollbar (mask-fade + custom draggable thumb) and adds wheel→horizontal; the vertical program scroller keeps the global vectant scrollbar.

**Tech Stack:** Next.js client components, React (hooks), Redux (`react-redux`), `lucide-react` icons, `sonner` toasts, Vitest + jsdom (`createRoot`), the docking-wm layout-slice.

**Spec:** `docs/superpowers/specs/2026-06-23-programs-panel-uiux-overhaul-design.md` (read it — the visual tokens, sizing, and IA mapping are the contract).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `synthi/src/components/programs/ProgramsPanel.jsx` | Shell: data load, handlers, `view` state, renders Library/Store. Keeps `openProgramSession` + consent state. | Rewrite (slim) |
| `synthi/src/components/programs/store/FilterStrip.jsx` | Horizontal chip strip: mask-fade ends, custom draggable thumb, wheel→horizontal. | Create |
| `synthi/src/components/programs/library/ProgramThumbnail.jsx` | Live `webGui` snapshot via `/wsport`. | Create |
| `synthi/src/components/programs/library/RunningCard.jsx` | Running program card: gradient shell, rim-glow, dot, ports, Open/Stop/Restart, thumbnail. | Create |
| `synthi/src/components/programs/library/ProgramTile.jsx` | Idle installed-program launch tile (+ scaffold affordance). | Create |
| `synthi/src/components/programs/library/LibraryView.jsx` | Library: header (Store button + refresh), detected banner, Running list, Installed grid, Browse-store tile. | Create |
| `synthi/src/components/programs/store/StoreTile.jsx` | 2-up store tile: icon plate, verified badge, meta, Install. | Create |
| `synthi/src/components/programs/store/ProgramDetail.jsx` | Detail + consent (scopes, version, Install/Approve). | Create |
| `synthi/src/components/programs/store/StoreView.jsx` | Store: pinned logo+back, search, manifest/publish, FilterStrip, 2-up grid, detail. | Create |
| `synthi/src/components/programs/programTokens.js` | Shared vectant style constants (shell, header, section label, etc.) so components stay DRY. | Create |
| `synthi/src/components/programs/__tests__/*` | Update existing suites for the new IA; add per-component tests. | Modify/Create |

**Convention:** components are presentational and receive data + callbacks as props. Use the shared style constants from `programTokens.js`; do not hardcode hexes in each component (single source of truth, matches the spec tokens).

**Test command (all tasks):** `(cd synthi && npx vitest run src/components/programs)` (cwd leaks across shell calls — always use the subshell).

---

## Task 1: Shared vectant style tokens

**Files:**
- Create: `synthi/src/components/programs/programTokens.js`
- Test: `synthi/src/components/programs/__tests__/programTokens.test.js`

- [ ] **Step 1: Write the failing test**

```js
/* @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { PROGRAM_STYLE, BRAND_GRADIENT } from '../programTokens';

describe('programTokens', () => {
  it('exposes vectant shell + header style objects and the brand gradient', () => {
    expect(PROGRAM_STYLE.panelShell.background).toContain('linear-gradient(180deg');
    expect(PROGRAM_STYLE.sectionLabel.textTransform).toBe('uppercase');
    expect(PROGRAM_STYLE.sectionLabel.color).toBe('var(--text-muted)');
    expect(BRAND_GRADIENT).toContain('var(--brand-gradient-horizontal)');
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/programTokens.test.js)`
Expected: FAIL — `Cannot find module '../programTokens'`.

- [ ] **Step 3: Implement**

```js
// synthi/src/components/programs/programTokens.js
// Single source of truth for the Programs panel's vectant styling. Values come
// straight from the design spec (globals.css tokens). Keep components DRY.

export const BRAND_GRADIENT = 'var(--brand-gradient-horizontal)';

export const PROGRAM_STYLE = {
  panelShell: {
    background: 'linear-gradient(180deg, #0e0f17, #0b0c12)',
    border: '1px solid var(--border-subtle)',
    boxShadow: '0 18px 44px rgba(0,0,0,0.45)',
  },
  header: {
    borderBottom: '1px solid var(--border-subtle)',
  },
  headerTitle: {
    fontSize: '11px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  sectionLabel: {
    fontSize: '10px',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
  },
  countChip: {
    color: 'var(--text-dim)',
  },
  surfaceCard: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: '10px',
  },
  runningShell: {
    background: 'linear-gradient(180deg, #1b1d2b, #14151f)',
    border: '1px solid var(--border-medium)',
    borderRadius: '11px',
    boxShadow: '0 0 0 1px rgba(181,69,255,0.16), 0 0 18px rgba(181,69,255,0.08)',
  },
  iconPlate: {
    background: 'var(--bg-elevated)',
    borderRadius: '9px',
  },
  ghostButton: {
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-medium)',
    borderRadius: '6px',
    background: 'transparent',
  },
  primaryButton: {
    color: '#fff',
    borderRadius: '7px',
    background: BRAND_GRADIENT,
  },
};
```

- [ ] **Step 4: Run it, verify it passes**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/programTokens.test.js)` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/programTokens.js synthi/src/components/programs/__tests__/programTokens.test.js
git commit -F - <<'EOF'
feat(programs): shared vectant style tokens for the panel overhaul

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 2: FilterStrip (navbar-style horizontal scroll)

**Files:**
- Create: `synthi/src/components/programs/store/FilterStrip.jsx`
- Test: `synthi/src/components/programs/__tests__/filterStrip.test.jsx`

Replicates `EditorTabStrip`'s scrollbar look/behavior (mask-fade ends + custom draggable thumb in a 3px lane) and **adds wheel→horizontal** (the editor strip has no wheel handler). Renders chips passed as props. We replicate rather than refactor `EditorTabStrip` — it is load-bearing for editor tabs and tightly coupled.

- [ ] **Step 1: Write the failing test**

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilterStrip from '../store/FilterStrip';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('FilterStrip', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const items = [{ id: 'all', label: 'All' }, { id: 'db', label: 'Databases' }, { id: 'api', label: 'API tools' }];

  it('renders chips, marks the active one, and fires onSelect', async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<FilterStrip items={items} activeId="all" onSelect={onSelect} />));
    expect(byTestId(container, 'filter-chip-db')).not.toBeNull();
    expect(byTestId(container, 'filter-chip-all').getAttribute('aria-pressed')).toBe('true');
    await act(async () => byTestId(container, 'filter-chip-db').click());
    expect(onSelect).toHaveBeenCalledWith('db');
  });

  it('translates vertical wheel into horizontal scroll', async () => {
    await act(async () => root.render(<FilterStrip items={items} activeId="all" onSelect={() => {}} />));
    const scroller = byTestId(container, 'filter-scroller');
    let scrolled = 0;
    Object.defineProperty(scroller, 'scrollLeft', { get: () => scrolled, set: (v) => { scrolled = v; }, configurable: true });
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    });
    expect(scrolled).toBe(40);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/filterStrip.test.jsx)` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```jsx
// synthi/src/components/programs/store/FilterStrip.jsx
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
```

- [ ] **Step 4: Run it, verify it passes**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/filterStrip.test.jsx)` — Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/store/FilterStrip.jsx synthi/src/components/programs/__tests__/filterStrip.test.jsx
git commit -F - <<'EOF'
feat(programs): FilterStrip with navbar-style scrollbar + wheel-to-horizontal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 3: ProgramThumbnail (live webGui snapshot)

**Files:**
- Create: `synthi/src/components/programs/library/ProgramThumbnail.jsx`
- Test: `synthi/src/components/programs/__tests__/programThumbnail.test.jsx`

A small preview for `webGui` running programs. It renders an `<img>` pointed at the `/wsport/<slug>/<port>/` stream root with a periodic cache-busting refresh (snapshot approach — lighter than a live iframe, respects reduced motion). Falls back to a neutral placeholder until the first frame loads or if no port.

- [ ] **Step 1: Write the failing test**

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ProgramThumbnail from '../library/ProgramThumbnail';

describe('ProgramThumbnail', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('points the preview at the /wsport stream for the slug + port', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={6901} />));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toContain('/wsport/rfxr7ism/6901/');
  });

  it('renders a placeholder (no img) when there is no port', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={null} />));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="thumb-placeholder"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `(cd synthi && npx vitest run src/components/programs/__tests__/programThumbnail.test.jsx)` → FAIL (module not found).

- [ ] **Step 3: Implement**

```jsx
// synthi/src/components/programs/library/ProgramThumbnail.jsx
'use client';

import { useEffect, useState } from 'react';

const REFRESH_MS = 5000;

/** Live-ish snapshot of a webGui program's /wsport stream. Snapshot, not iframe:
 *  periodically re-fetches the stream root as an <img>. Reduced-motion → one frame. */
export default function ProgramThumbnail({ slug, port }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!slug || !port) return undefined;
    const reduced = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduced) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [slug, port]);

  const base = {
    height: '54px',
    borderRadius: '7px',
    border: '1px solid var(--border-subtle)',
    overflow: 'hidden',
    position: 'relative',
  };

  if (!slug || !port) {
    return (
      <div
        data-testid="thumb-placeholder"
        style={{ ...base, background: 'radial-gradient(120% 80% at 30% 20%, #16203a, #07080d)' }}
      />
    );
  }

  return (
    <div style={{ ...base, background: '#07080d' }}>
      <img
        alt=""
        aria-hidden="true"
        src={`/wsport/${encodeURIComponent(slug)}/${port}/?thumb=${tick}`}
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
      />
      <span
        style={{ position: 'absolute', top: '5px', left: '6px', fontSize: '8px', color: '#bfe7cf', background: 'rgba(74,222,128,0.16)', borderRadius: '4px', padding: '1px 5px' }}
      >
        live
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/library/ProgramThumbnail.jsx synthi/src/components/programs/__tests__/programThumbnail.test.jsx
git commit -F - <<'EOF'
feat(programs): ProgramThumbnail live snapshot for webGui running cards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 4: RunningCard

**Files:**
- Create: `synthi/src/components/programs/library/RunningCard.jsx`
- Test: `synthi/src/components/programs/__tests__/runningCard.test.jsx`

Uses `programSessionSections` helpers (`formatProgramSessionPorts`, `canRestartProgramSession`, `isActiveProgramSession`). Shows the thumbnail only when `session.webGui`. Calls `onOpen/onStop/onRestart` props.

- [ ] **Step 1: Write the failing test**

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RunningCard from '../library/RunningCard';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('RunningCard', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const base = { id: 'ps1', state: 'running', runtimeType: 'container', webGui: true, webPort: 6901, activePorts: [6901], workspaceSlug: 'team' };

  it('renders ports, a thumbnail for webGui, and fires onStop', async () => {
    const onStop = vi.fn();
    await act(async () => root.render(<RunningCard session={base} slug="team" onOpen={() => {}} onStop={onStop} onRestart={() => {}} />));
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).toContain(':6901');
    await act(async () => byTestId(container, 'running-stop-ps1').click());
    expect(onStop).toHaveBeenCalledWith(base);
  });

  it('omits the thumbnail for a non-webGui session', async () => {
    await act(async () => root.render(<RunningCard session={{ ...base, webGui: false }} slug="team" onOpen={() => {}} onStop={() => {}} onRestart={() => {}} />));
    expect(container.querySelector('img')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement**

```jsx
// synthi/src/components/programs/library/RunningCard.jsx
'use client';

import { Square, RotateCcw } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';
import { canRestartProgramSession, formatProgramSessionPorts } from '../programSessionSections';
import ProgramThumbnail from './ProgramThumbnail';

function shortLabel(session) {
  return session?.title || (session?.id ? `Session ${String(session.id).slice(0, 8)}` : 'Program');
}

export default function RunningCard({ session, slug, onOpen, onStop, onRestart }) {
  const ports = formatProgramSessionPorts(session);
  const canRestart = canRestartProgramSession(session);
  const btn = { ...PROGRAM_STYLE.ghostButton, fontSize: '10px', padding: '3px 9px', cursor: 'pointer' };

  return (
    <div style={{ ...PROGRAM_STYLE.runningShell, padding: '9px' }}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 min-w-0" style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
          <span className="truncate">{shortLabel(session)}</span>
        </span>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: 'var(--accent-success)', boxShadow: '0 0 7px var(--accent-success)' }} />
      </div>

      {session?.webGui ? (
        <div className="mt-2">
          <ProgramThumbnail slug={slug} port={session.webPort || null} />
        </div>
      ) : null}

      <div className="flex items-center gap-2 mt-2">
        <span style={{ fontSize: '9px', color: '#bfe7cf', background: 'rgba(74,222,128,0.14)', borderRadius: '5px', padding: '2px 7px' }}>
          {String(session?.state || 'running')}
        </span>
        {ports ? <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>:{ports}</span> : null}
        <span className="flex-1" />
        <button type="button" data-testid={`running-open-${session.id}`} onClick={() => onOpen(session)} style={{ ...btn, color: 'var(--text-primary)' }}>Open</button>
        {canRestart ? (
          <button type="button" data-testid={`running-restart-${session.id}`} onClick={() => onRestart(session)} style={btn}>
            <span className="inline-flex items-center gap-1"><RotateCcw className="w-3 h-3" /> Restart</span>
          </button>
        ) : (
          <button type="button" data-testid={`running-stop-${session.id}`} onClick={() => onStop(session)} style={btn}>
            <span className="inline-flex items-center gap-1"><Square className="w-3 h-3" /> Stop</span>
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/library/RunningCard.jsx synthi/src/components/programs/__tests__/runningCard.test.jsx
git commit -F - <<'EOF'
feat(programs): RunningCard with rim-glow shell, ports, and webGui thumbnail

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 5: ProgramTile (idle install tile)

**Files:**
- Create: `synthi/src/components/programs/library/ProgramTile.jsx`
- Test: `synthi/src/components/programs/__tests__/programTile.test.jsx`

A click-to-launch tile for an installed program. Optional "Set up project" (scaffold) affordance. Preserves the existing `data-testid`s `launch-install-<id>` and `scaffold-<id>` so the integration suite still targets them.

- [ ] **Step 1: Write the failing test**

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgramTile from '../library/ProgramTile';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('ProgramTile', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const install = { id: 'inst1', packageId: '@vectant/dbeaver', version: '1.0.0', status: 'installed' };

  it('launches on click and shows scaffold when scaffoldable', async () => {
    const onLaunch = vi.fn(); const onScaffold = vi.fn();
    await act(async () => root.render(<ProgramTile install={install} canManage scaffoldable onLaunch={onLaunch} onScaffold={onScaffold} />));
    await act(async () => byTestId(container, 'launch-install-inst1').click());
    expect(onLaunch).toHaveBeenCalledWith(install);
    expect(byTestId(container, 'scaffold-inst1')).not.toBeNull();
  });

  it('hides actions for a read-only member', async () => {
    await act(async () => root.render(<ProgramTile install={install} canManage={false} scaffoldable onLaunch={() => {}} onScaffold={() => {}} />));
    expect(byTestId(container, 'launch-install-inst1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```jsx
// synthi/src/components/programs/library/ProgramTile.jsx
'use client';

import { Wrench } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';

function shortName(packageId) {
  return String(packageId || 'program').split('/').pop();
}

export default function ProgramTile({ install, canManage, scaffoldable, onLaunch, onScaffold }) {
  const launch = () => canManage && onLaunch(install);
  return (
    <div
      style={{ ...PROGRAM_STYLE.surfaceCard, padding: '10px 7px' }}
      className="flex flex-col items-center gap-1.5 text-center"
    >
      <div style={{ ...PROGRAM_STYLE.iconPlate, width: '32px', height: '32px' }} className="flex items-center justify-center" />
      <span style={{ color: 'var(--text-primary)', fontSize: '11px' }} className="truncate max-w-full">{shortName(install.packageId)}</span>
      <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>v{install.version}</span>
      {canManage ? (
        <div className="flex items-center gap-1 mt-1">
          {scaffoldable ? (
            <button
              type="button"
              data-testid={`scaffold-${install.id}`}
              onClick={() => onScaffold(install)}
              style={{ ...PROGRAM_STYLE.ghostButton, fontSize: '10px', padding: '3px 7px', cursor: 'pointer' }}
            >
              <span className="inline-flex items-center gap-1"><Wrench className="w-3 h-3" /> Set up</span>
            </button>
          ) : null}
          <button
            type="button"
            data-testid={`launch-install-${install.id}`}
            onClick={launch}
            style={{ ...PROGRAM_STYLE.primaryButton, fontSize: '10px', padding: '4px 12px', cursor: 'pointer' }}
          >
            Launch
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/library/ProgramTile.jsx synthi/src/components/programs/__tests__/programTile.test.jsx
git commit -F - <<'EOF'
feat(programs): ProgramTile idle launch tile (with scaffold affordance)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 6: LibraryView

**Files:**
- Create: `synthi/src/components/programs/library/LibraryView.jsx`
- Test: `synthi/src/components/programs/__tests__/libraryView.test.jsx`

Composes the Library: header (`Programs` + `Store` button (`data-testid="open-store"`) + refresh), the detected banner (`data-testid="detected-program"` / `launch-detected`, role-gated), the Running section (RunningCards), the Installed grid (ProgramTiles) + a "Browse store" tile. Receives data + handlers as props from the shell. Uses `buildProgramSessionSections`.

- [ ] **Step 1: Write the failing test**

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LibraryView from '../library/LibraryView';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }
const noop = () => {};
const baseProps = {
  canManage: true, slug: 'team',
  sessions: [{ id: 'ps1', state: 'running', runtimeType: 'container', webGui: true, webPort: 6901, activePorts: [6901] }],
  installs: [{ id: 'inst1', packageId: '@vectant/dbeaver', version: '1.0.0', status: 'installed' }],
  detected: null, loading: false,
  onOpenStore: noop, onRefresh: noop, onOpenSession: noop, onStop: noop, onRestart: noop,
  onLaunchInstall: noop, onScaffold: noop, onLaunchDetected: noop, scaffoldableIds: [],
};

describe('LibraryView', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('renders running cards + installed tiles and exposes a Store entry', async () => {
    await act(async () => root.render(<LibraryView {...baseProps} />));
    expect(byTestId(container, 'running-open-ps1')).not.toBeNull();
    expect(byTestId(container, 'launch-install-inst1')).not.toBeNull();
    expect(byTestId(container, 'open-store')).not.toBeNull();
  });

  it('fires onOpenStore from the header Store button and the Browse tile', async () => {
    const onOpenStore = vi.fn();
    await act(async () => root.render(<LibraryView {...baseProps} onOpenStore={onOpenStore} />));
    await act(async () => byTestId(container, 'open-store').click());
    await act(async () => byTestId(container, 'browse-store-tile').click());
    expect(onOpenStore).toHaveBeenCalledTimes(2);
  });

  it('shows the detected banner only when detected and manageable', async () => {
    await act(async () => root.render(<LibraryView {...baseProps} detected={{ source: 'docker-compose.yml' }} />));
    expect(byTestId(container, 'detected-program').textContent).toContain('docker-compose.yml');
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```jsx
// synthi/src/components/programs/library/LibraryView.jsx
'use client';

import { Command, RefreshCw, ExternalLink, Play, Store, Plus } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';
import { buildProgramSessionSections } from '../programSessionSections';
import RunningCard from './RunningCard';
import ProgramTile from './ProgramTile';

function SectionLabel({ children, count }) {
  return (
    <div className="flex items-center justify-between" style={PROGRAM_STYLE.sectionLabel}>
      <span>{children}</span>
      {typeof count === 'number' ? <span style={PROGRAM_STYLE.countChip}>{count}</span> : null}
    </div>
  );
}

export default function LibraryView({
  canManage, slug, sessions, installs, detected, loading,
  onOpenStore, onRefresh, onOpenSession, onStop, onRestart,
  onLaunchInstall, onScaffold, onLaunchDetected, scaffoldableIds = [],
}) {
  const { running } = buildProgramSessionSections(sessions);

  return (
    <div className="flex flex-col h-full min-h-0" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center justify-between px-3 py-2" style={PROGRAM_STYLE.header}>
        <span className="flex items-center gap-2" style={PROGRAM_STYLE.headerTitle}>
          <Command className="w-3.5 h-3.5" /> Programs
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="open-store"
            onClick={onOpenStore}
            className="inline-flex items-center gap-1.5 cursor-pointer"
            style={{ fontSize: '10px', color: '#c6b8ff', border: '1px solid var(--border-medium)', borderRadius: '7px', padding: '3px 8px' }}
          >
            Store <ExternalLink className="w-3 h-3" />
          </button>
          <button type="button" onClick={onRefresh} title="Refresh" className="cursor-pointer" style={{ color: 'var(--text-muted)' }}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        {canManage && detected ? (
          <div data-testid="detected-program" className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
            style={{ ...PROGRAM_STYLE.surfaceCard, borderColor: 'color-mix(in srgb, var(--accent-primary) 35%, var(--border-subtle))' }}>
            <div className="min-w-0">
              <div style={{ fontSize: '13px' }}>Detected in this repo</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{detected.source}</div>
            </div>
            <button type="button" data-testid="launch-detected" onClick={onLaunchDetected}
              className="inline-flex items-center gap-1 cursor-pointer" style={{ ...PROGRAM_STYLE.primaryButton, fontSize: '11px', padding: '5px 10px' }}>
              <Play className="w-3.5 h-3.5" /> Run
            </button>
          </div>
        ) : null}

        <section className="flex flex-col gap-2">
          <SectionLabel count={running.length}>Running</SectionLabel>
          {loading ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading…</div>
          ) : running.length === 0 ? (
            <div className="rounded-lg px-3 py-4" style={{ ...PROGRAM_STYLE.surfaceCard, fontSize: '12px', color: 'var(--text-muted)' }}>Nothing running.</div>
          ) : (
            running.map((s) => (
              <RunningCard key={s.id} session={s} slug={slug} onOpen={onOpenSession} onStop={onStop} onRestart={onRestart} />
            ))
          )}
        </section>

        <section className="flex flex-col gap-2">
          <SectionLabel count={installs.length}>Installed</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {installs.map((install) => (
              <ProgramTile
                key={install.id}
                install={install}
                canManage={canManage}
                scaffoldable={scaffoldableIds.includes(install.packageId)}
                onLaunch={onLaunchInstall}
                onScaffold={onScaffold}
              />
            ))}
            <button
              type="button"
              data-testid="browse-store-tile"
              onClick={onOpenStore}
              className="flex flex-col items-center justify-center gap-1.5 cursor-pointer"
              style={{ border: '1px dashed var(--border-medium)', borderRadius: '10px', padding: '10px 7px', color: 'var(--text-secondary)' }}
            >
              <span className="flex items-center justify-center" style={{ width: '32px', height: '32px', borderRadius: '9px', background: 'linear-gradient(135deg, rgba(162,61,255,0.28), rgba(61,109,255,0.28))', color: '#c6b8ff' }}>
                <Store className="w-4 h-4" />
              </span>
              <span style={{ fontSize: '11px' }}>Browse store</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/library/LibraryView.jsx synthi/src/components/programs/__tests__/libraryView.test.jsx
git commit -F - <<'EOF'
feat(programs): LibraryView — running cards, installed tiles, store entry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 7: StoreTile

**Files:**
- Create: `synthi/src/components/programs/store/StoreTile.jsx`
- Test: `synthi/src/components/programs/__tests__/storeTile.test.jsx`

2-up tile. Preserves `data-testid`s `marketplace-item-<pkg>`, `verified-badge-<pkg>`, `install-published-<pkg>` so the integration suite keeps working. Verified badge uses the brand gradient; community apps show a `community` meta and no badge.

- [ ] **Step 1: Write the failing test**

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StoreTile from '../store/StoreTile';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('StoreTile', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('shows a verified badge for verified items and installs on click', async () => {
    const onInstall = vi.fn();
    const item = { packageId: '@vectant/dbeaver', displayName: 'DBeaver', verified: true, installCount: 1200, latestVersion: '1.0.0' };
    await act(async () => root.render(<StoreTile item={item} canManage onInstall={onInstall} onOpenDetail={() => {}} />));
    expect(byTestId(container, 'verified-badge-@vectant/dbeaver')).not.toBeNull();
    await act(async () => byTestId(container, 'install-published-@vectant/dbeaver').click());
    expect(onInstall).toHaveBeenCalledWith(item);
  });

  it('omits the verified badge for community items', async () => {
    const item = { packageId: '@other/pgadmin', displayName: 'pgAdmin', verified: false, installCount: 5, latestVersion: '1.0.0' };
    await act(async () => root.render(<StoreTile item={item} canManage onInstall={() => {}} onOpenDetail={() => {}} />));
    expect(byTestId(container, 'verified-badge-@other/pgadmin')).toBeNull();
    expect(byTestId(container, 'marketplace-item-@other/pgadmin').textContent).toContain('community');
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```jsx
// synthi/src/components/programs/store/StoreTile.jsx
'use client';

import { ShieldCheck, Download } from 'lucide-react';
import { PROGRAM_STYLE, BRAND_GRADIENT } from '../programTokens';

export default function StoreTile({ item, canManage, onInstall, onOpenDetail }) {
  const name = item.displayName || item.packageId;
  const meta = item.verified ? `${item.installCount || 0} installs` : `community · ${item.installCount || 0}`;
  return (
    <div
      data-testid={`marketplace-item-${item.packageId}`}
      style={{ ...PROGRAM_STYLE.surfaceCard, padding: '10px' }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-start justify-between">
        <button type="button" onClick={() => onOpenDetail(item)} className="cursor-pointer" style={{ ...PROGRAM_STYLE.iconPlate, width: '30px', height: '30px' }} aria-label={`Open ${name}`} />
        {item.verified ? (
          <span data-testid={`verified-badge-${item.packageId}`} aria-label="Verified"
            className="inline-flex items-center" style={{ background: BRAND_GRADIENT, borderRadius: '5px', padding: '2px 4px', color: '#fff' }}>
            <ShieldCheck className="w-2.5 h-2.5" />
          </span>
        ) : null}
      </div>
      <button type="button" onClick={() => onOpenDetail(item)} className="text-left cursor-pointer min-w-0">
        <div className="truncate" style={{ color: 'var(--text-primary)', fontSize: '12px' }}>{name}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '9px' }}>{meta}</div>
      </button>
      {canManage ? (
        <button
          type="button"
          data-testid={`install-published-${item.packageId}`}
          onClick={() => onInstall(item)}
          className="inline-flex items-center justify-center gap-1 cursor-pointer"
          style={{ ...PROGRAM_STYLE.ghostButton, color: 'var(--text-primary)', fontSize: '10px', padding: '4px' }}
        >
          <Download className="w-3 h-3" /> Install
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/store/StoreTile.jsx synthi/src/components/programs/__tests__/storeTile.test.jsx
git commit -F - <<'EOF'
feat(programs): StoreTile (2-up) with verified badge + install

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 8: ProgramDetail (detail + consent)

**Files:**
- Create: `synthi/src/components/programs/store/ProgramDetail.jsx`
- Test: `synthi/src/components/programs/__tests__/programDetail.test.jsx`

Replaces the old inline `ConsentPrompt`. Shows description + requested scopes (prominent) + version + Install. When `requestedScopes` is non-empty it renders the consent affordance with `data-testid="consent-prompt"` / `approve-consent` (preserving the integration suite's hooks). Communicates the hosted-app framing in copy.

- [ ] **Step 1: Write the failing test**

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgramDetail from '../store/ProgramDetail';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }
const item = { packageId: '@other/web', displayName: 'Web', description: 'A community app', latestVersion: '1.0.0', verified: false };

describe('ProgramDetail', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('installs on click when no consent is pending', async () => {
    const onInstall = vi.fn();
    await act(async () => root.render(<ProgramDetail item={item} requestedScopes={[]} busy={false} onInstall={onInstall} onApprove={() => {}} onBack={() => {}} />));
    await act(async () => byTestId(container, 'detail-install').click());
    expect(onInstall).toHaveBeenCalledWith(item);
  });

  it('shows the consent prompt with scopes and approves', async () => {
    const onApprove = vi.fn();
    await act(async () => root.render(<ProgramDetail item={item} requestedScopes={['program.launch', 'network.outbound']} busy={false} onInstall={() => {}} onApprove={onApprove} onBack={() => {}} />));
    const prompt = byTestId(container, 'consent-prompt');
    expect(prompt.textContent).toContain('program.launch');
    expect(prompt.textContent).toContain('network.outbound');
    await act(async () => byTestId(container, 'approve-consent').click());
    expect(onApprove).toHaveBeenCalledWith(item, ['program.launch', 'network.outbound']);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```jsx
// synthi/src/components/programs/store/ProgramDetail.jsx
'use client';

import { ArrowLeft, ShieldCheck, Download } from 'lucide-react';
import { PROGRAM_STYLE, BRAND_GRADIENT } from '../programTokens';

export default function ProgramDetail({ item, requestedScopes = [], busy, onInstall, onApprove, onBack }) {
  const name = item.displayName || item.packageId;
  const needsConsent = requestedScopes.length > 0;
  return (
    <div className="flex flex-col h-full min-h-0" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={PROGRAM_STYLE.header}>
        <button type="button" data-testid="detail-back" onClick={onBack} className="cursor-pointer" style={{ color: 'var(--text-secondary)' }}><ArrowLeft className="w-4 h-4" /></button>
        <span style={{ fontSize: '13px' }} className="truncate">{name}</span>
        {item.verified ? <span aria-label="Verified" className="inline-flex items-center" style={{ background: BRAND_GRADIENT, borderRadius: '5px', padding: '2px 5px', color: '#fff' }}><ShieldCheck className="w-3 h-3" /></span> : null}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{item.description || 'No description.'}</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          v{item.latestVersion} · {item.verified ? 'verified by vectant' : 'community'} · runs hosted in your workspace
        </div>

        {needsConsent ? (
          <div data-testid="consent-prompt" className="rounded-lg px-3 py-3 flex flex-col gap-2"
            style={{ ...PROGRAM_STYLE.surfaceCard, borderColor: 'color-mix(in srgb, var(--accent-primary) 35%, var(--border-subtle))' }}>
            <div className="flex items-center gap-2" style={{ fontSize: '13px' }}>
              <ShieldCheck className="w-4 h-4" style={{ color: 'var(--attention-purple)' }} /> Permission consent required
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>This program requests:</div>
            <ul className="flex flex-wrap gap-1.5">
              {requestedScopes.map((s) => (
                <li key={s} style={{ fontSize: '11px', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '2px 6px' }}>{s}</li>
              ))}
            </ul>
            <button type="button" data-testid="approve-consent" disabled={busy} onClick={() => onApprove(item, requestedScopes)}
              className="inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
              style={{ ...PROGRAM_STYLE.primaryButton, fontSize: '11px', padding: '5px 10px' }}>
              <ShieldCheck className="w-3 h-3" /> {busy ? 'Approving…' : 'Approve & install'}
            </button>
          </div>
        ) : (
          <button type="button" data-testid="detail-install" disabled={busy} onClick={() => onInstall(item)}
            className="inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
            style={{ ...PROGRAM_STYLE.primaryButton, fontSize: '12px', padding: '7px 12px' }}>
            <Download className="w-4 h-4" /> {busy ? 'Installing…' : 'Install'}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/store/ProgramDetail.jsx synthi/src/components/programs/__tests__/programDetail.test.jsx
git commit -F - <<'EOF'
feat(programs): ProgramDetail with prominent scopes + hosted-app framing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 9: StoreView

**Files:**
- Create: `synthi/src/components/programs/store/StoreView.jsx`
- Test: `synthi/src/components/programs/__tests__/storeView.test.jsx`

Composes the Store per the spec order: pinned logo + back → search → manifest/publish → FilterStrip → 2-up grid. Owns the category `activeFilter` + search query (local), filters the `marketplace` prop, and routes tile taps to a `ProgramDetail` (local `selected` state). Preserves `install-from-manifest` and `publish-program` testids.

- [ ] **Step 1: Write the failing test**

```jsx
/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StoreView from '../store/StoreView';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }
const noop = () => {};
const baseProps = {
  canManage: true, marketplace: [
    { packageId: '@vectant/dbeaver', displayName: 'DBeaver', verified: true, installCount: 9, latestVersion: '1.0.0' },
  ],
  query: '', onQueryChange: noop, onBack: noop, onInstallManifest: noop, onPublish: noop,
  onInstallPublished: noop, requestedScopes: [], consentItem: null, busy: false, onApprove: noop,
};

describe('StoreView', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('renders the pinned actions + a tile, and opens detail on tile tap', async () => {
    await act(async () => root.render(<StoreView {...baseProps} />));
    expect(byTestId(container, 'install-from-manifest')).not.toBeNull();
    expect(byTestId(container, 'publish-program')).not.toBeNull();
    expect(byTestId(container, 'marketplace-item-@vectant/dbeaver')).not.toBeNull();
    await act(async () => byTestId(container, 'install-published-@vectant/dbeaver').click());
    // install routes through detail; with empty scopes the detail install fires onInstallPublished
  });

  it('back button returns to the Library', async () => {
    const onBack = vi.fn();
    await act(async () => root.render(<StoreView {...baseProps} onBack={onBack} />));
    await act(async () => byTestId(container, 'store-back').click());
    expect(onBack).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```jsx
// synthi/src/components/programs/store/StoreView.jsx
'use client';

import { useMemo, useState } from 'react';
import { Store, ArrowLeft, Search, FileInput, UploadCloud } from 'lucide-react';
import { PROGRAM_STYLE } from '../programTokens';
import FilterStrip from './FilterStrip';
import StoreTile from './StoreTile';
import ProgramDetail from './ProgramDetail';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'databases', label: 'Databases' },
  { id: 'api', label: 'API tools' },
  { id: 'dev', label: 'Dev servers' },
  { id: 'gui', label: 'Desktop GUIs' },
  { id: 'community', label: 'Community' },
];

export default function StoreView({
  canManage, marketplace, query, onQueryChange, onBack,
  onInstallManifest, onPublish, onInstallPublished,
  requestedScopes, consentItem, busy, onApprove,
}) {
  const [activeFilter, setActiveFilter] = useState('all');
  const [selected, setSelected] = useState(null);

  const detailItem = consentItem || selected;
  const filtered = useMemo(() => {
    if (activeFilter === 'community') return marketplace.filter((m) => !m.verified);
    return marketplace;
  }, [marketplace, activeFilter]);

  if (detailItem) {
    return (
      <ProgramDetail
        item={detailItem}
        requestedScopes={consentItem ? requestedScopes : []}
        busy={busy}
        onInstall={(item) => onInstallPublished(item)}
        onApprove={(item, scopes) => onApprove(item, scopes)}
        onBack={() => setSelected(null)}
      />
    );
  }

  const action = { ...PROGRAM_STYLE.ghostButton, fontSize: '10px', padding: '6px 10px', color: 'var(--text-secondary)', cursor: 'pointer' };

  return (
    <div className="flex flex-col h-full min-h-0" style={{ color: 'var(--text-primary)' }}>
      <div className="flex items-center gap-2 px-3 py-2" style={PROGRAM_STYLE.header}>
        <button type="button" data-testid="store-back" onClick={onBack} className="cursor-pointer" style={{ color: 'var(--text-secondary)' }}><ArrowLeft className="w-4 h-4" /></button>
        <span className="flex items-center gap-2" style={{ fontSize: '14px' }}><Store className="w-4 h-4" style={{ color: '#c6b8ff' }} /> Store</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        <div className="flex items-center gap-2 px-2.5 py-2" style={{ background: 'var(--bg-app, #0a0b11)', border: '1px solid var(--border-subtle)', borderRadius: '8px' }}>
          <Search className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search programs"
            className="flex-1 bg-transparent outline-none"
            style={{ fontSize: '12px', color: 'var(--text-primary)' }}
          />
        </div>

        {canManage ? (
          <div className="flex gap-2">
            <button type="button" data-testid="install-from-manifest" onClick={onInstallManifest} style={{ ...action, flex: 1 }} className="inline-flex items-center justify-center gap-1.5">
              <FileInput className="w-3.5 h-3.5" /> Install from manifest
            </button>
            <button type="button" data-testid="publish-program" onClick={onPublish} style={action} className="inline-flex items-center gap-1.5">
              <UploadCloud className="w-3.5 h-3.5" /> Publish
            </button>
          </div>
        ) : null}

        <FilterStrip items={FILTERS} activeId={activeFilter} onSelect={setActiveFilter} />

        {filtered.length === 0 ? (
          <div className="rounded-lg px-3 py-4" style={{ ...PROGRAM_STYLE.surfaceCard, fontSize: '12px', color: 'var(--text-muted)' }}>No programs match.</div>
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {filtered.map((item) => (
              <StoreTile
                key={item.packageId}
                item={item}
                canManage={canManage}
                onInstall={(it) => onInstallPublished(it)}
                onOpenDetail={(it) => setSelected(it)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run it, verify it passes** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/store/StoreView.jsx synthi/src/components/programs/__tests__/storeView.test.jsx
git commit -F - <<'EOF'
feat(programs): StoreView — pinned logo/search/actions, filter strip, 2-up grid

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 10: Rewire ProgramsPanel shell + migrate the integration tests

**Files:**
- Rewrite: `synthi/src/components/programs/ProgramsPanel.jsx`
- Modify: `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx`
- Modify: `synthi/src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx`

The shell keeps ALL current data loading + handlers + `openProgramSession` (docking integration) verbatim, drops the ad-hoc "Launch Command" form, adds `view` state (`'library' | 'store'`), and renders `LibraryView` or `StoreView`. Store-housed controls now live behind the `open-store` navigation, so the existing tests must click `open-store` first.

- [ ] **Step 1: Update the existing integration tests for the new IA**

In `programsPanelInstall.test.jsx`, add a navigation helper and use it before any Store-housed interaction (`install-from-manifest`, `publish-program`, `marketplace-item-*`, `install-published-*`, `verified-badge-*`). Library-housed ones (`launch-install-*`, `scaffold-*`, `detected-program`, `launch-detected`) stay as-is.

```jsx
async function openStore(container) {
  await act(async () => { byTestId(container, 'open-store').click(); });
  await flush();
}
```

Apply it: e.g. the consent test becomes —

```jsx
  it('shows a consent prompt listing the requested scopes when install needs consent', async () => {
    h.installWorkspaceProgram.mockRejectedValueOnce({ status: 409, body: { requested: ['program.launch', 'network.outbound'] } });
    await render();
    await openStore(container);
    await act(async () => { byTestId(container, 'install-from-manifest').click(); });
    await flush();
    const prompt = byTestId(container, 'consent-prompt');
    expect(prompt).not.toBeNull();
    expect(prompt.textContent).toContain('program.launch');
    expect(prompt.textContent).toContain('network.outbound');
  });
```

Do the same (`await openStore(container)` after `render()`) for: the grantScopes re-submit test, the 422 manifest test, the publish test, the marketplace list/install test, and the verified-badge test. The member-role test for `install-from-manifest`/`publish-program` should assert they're absent **after** `openStore` (or assert `open-store` still renders but the actions are hidden) — update to: render, `openStore`, then `expect(byTestId(container,'install-from-manifest')).toBeNull()`.

- [ ] **Step 2: Run the (now-updated) integration tests — verify they FAIL against the old panel**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/programsPanelInstall.test.jsx)`
Expected: FAIL — there is no `open-store` button in the current panel yet.

- [ ] **Step 3: Rewrite `ProgramsPanel.jsx` as the shell**

Keep the existing imports for docking actions, `toast`, `programsClient`, `programSessionSections`, `SCAFFOLDABLE_PACKAGE_IDS`, `IDE_PANEL`. Preserve `openProgramSession`, `load`, and every handler body exactly as today; only the render changes + the command form is removed + `view`/`marketQuery` state.

```jsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import {
  fetchProgramSessions, restartProgramSession, stopProgramSession,
  fetchInstalledPrograms, installWorkspaceProgram, launchInstalledProgram,
  publishWorkspaceProgram, fetchMarketplace, installPublishedProgram,
  scaffoldProgram, fetchDetectedProgram, launchDetectedProgram,
} from './programsClient';
import { SCAFFOLDABLE_PACKAGE_IDS } from '@/lib/programs/scaffoldTemplates';
import { isTerminalRuntimeType } from './programSessionSections';
import {
  activateTabAction, openTab, openFloatingPanel, bringFloatToFrontAction,
  selectNodes, selectTabs, selectFloating, setFocusedTabGroup,
} from '@/components/docking-wm/state/layout-slice';
import { IDE_PANEL } from '@/components/docking-wm/panels/panel-types';
import { setShowTerminal } from '@/redux/uiSlice';
import { PROGRAM_STYLE } from './programTokens';
import LibraryView from './library/LibraryView';
import StoreView from './store/StoreView';

function sessionLabel(session) {
  if (!session?.id) return 'Program session';
  return `Session ${String(session.id).slice(0, 8)}`;
}

// findProgramSessionTab / findProgramSessionFloat / findEditorGroupId: copy verbatim
// from the current ProgramsPanel.jsx (unchanged).

export default function ProgramsPanel() {
  const dispatch = useDispatch();
  const workspaceSlug = useSelector((s) => s.workspace?.slug || null);
  const workspaceRole = useSelector((s) => s.workspace?.role || null);
  const nodes = useSelector(selectNodes);
  const tabs = useSelector(selectTabs);
  const floating = useSelector(selectFloating);

  const [view, setView] = useState('library');
  const [sessions, setSessions] = useState([]);
  const [installs, setInstalls] = useState([]);
  const [marketplace, setMarketplace] = useState([]);
  const [marketQuery, setMarketQuery] = useState('');
  const [detected, setDetected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [consent, setConsent] = useState(null); // { requested, published }
  const [busy, setBusy] = useState(false);

  const canManage = workspaceRole !== 'member';

  // load(): identical to today's (Promise.all of the four fetches). Keep verbatim.
  const load = useCallback(async () => { /* …unchanged body from current file… */ }, [workspaceSlug, marketQuery]);
  useEffect(() => { load(); }, [load]);

  // openProgramSession(...): copy verbatim from the current file (terminal routing,
  // existing-tab focus, floating for webGui, docked tab default).
  const openProgramSession = useCallback(/* …unchanged… */ () => {}, [dispatch, nodes, tabs, floating, workspaceSlug]);

  // Handlers below keep the SAME bodies as today (toasts, error codes, load()):
  const handleStop = useCallback(/* unchanged */ () => {}, [load, workspaceSlug]);
  const handleRestart = useCallback(/* unchanged */ () => {}, [load, workspaceSlug]);
  const handleLaunchInstall = useCallback(/* unchanged */ () => {}, [load, openProgramSession, workspaceSlug]);
  const handleScaffold = useCallback(/* unchanged */ () => {}, [handleLaunchInstall, workspaceSlug]);
  const handleLaunchDetected = useCallback(/* unchanged */ () => {}, [load, openProgramSession, workspaceSlug]);
  const handlePublish = useCallback(/* unchanged */ () => {}, [load, workspaceSlug]);

  // install-from-manifest: same body as today's handleInstall (409 → setConsent({requested}); 404/422 toasts).
  const handleInstallManifest = useCallback(async (grantScopes) => { /* unchanged handleInstall body */ }, [load, workspaceSlug]);

  // published install: same body as today's handleInstallPublished (409 → setConsent({requested, published: item})).
  const handleInstallPublished = useCallback(async (item, grantScopes) => { /* unchanged */ }, [load, workspaceSlug]);

  const onApprove = useCallback((item, scopes) => (
    consent?.published ? handleInstallPublished(consent.published, scopes) : handleInstallManifest(scopes)
  ), [consent, handleInstallManifest, handleInstallPublished]);

  return (
    <div className="flex flex-col h-full min-h-0" style={{ ...PROGRAM_STYLE.panelShell, borderRadius: '0' }}>
      {view === 'library' ? (
        <LibraryView
          canManage={canManage}
          slug={workspaceSlug}
          sessions={sessions}
          installs={installs}
          detected={detected}
          loading={loading}
          scaffoldableIds={SCAFFOLDABLE_PACKAGE_IDS}
          onOpenStore={() => setView('store')}
          onRefresh={load}
          onOpenSession={openProgramSession}
          onStop={handleStop}
          onRestart={handleRestart}
          onLaunchInstall={handleLaunchInstall}
          onScaffold={handleScaffold}
          onLaunchDetected={handleLaunchDetected}
        />
      ) : (
        <StoreView
          canManage={canManage}
          marketplace={marketplace}
          query={marketQuery}
          onQueryChange={setMarketQuery}
          onBack={() => { setView('library'); setConsent(null); }}
          onInstallManifest={() => handleInstallManifest()}
          onPublish={handlePublish}
          onInstallPublished={(item) => handleInstallPublished(item)}
          requestedScopes={consent?.requested || []}
          consentItem={consent ? (consent.published || { packageId: '__manifest__', displayName: 'Workspace program', latestVersion: '', verified: false }) : null}
          busy={busy}
          onApprove={onApprove}
        />
      )}
    </div>
  );
}
```

Notes for the implementer:
- Copy the unchanged helper functions and handler bodies verbatim from the current `ProgramsPanel.jsx` (this plan elides them with comments only to avoid duplicating ~200 lines; they do not change).
- Set `setBusy(true/false)` around install calls if you want the busy state on the detail button (optional; current code uses `installing`).
- The `consentItem` for a manifest install (no published item) is a synthetic record so `ProgramDetail` can render the scopes; the manifest install path keys off `consent.published` being absent.

- [ ] **Step 4: Run the integration tests + the full programs suite**

Run: `(cd synthi && npx vitest run src/components/programs)`
Expected: PASS — the migrated `programsPanelInstall` + `programsPanelTerminalRouting` suites and all new component tests are green.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/ProgramsPanel.jsx synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx synthi/src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx
git commit -F - <<'EOF'
feat(programs): rewire ProgramsPanel as Library/Store shell; drop command box

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
```

---

## Task 11: Full-suite verification

- [ ] **Step 1:** Run the whole programs lib + components suite.

Run: `(cd synthi && npx vitest run src/lib/programs src/components/programs)`
Expected: all green (the lib suite is unchanged; components suite covers the overhaul).

- [ ] **Step 2:** Sanity-check the broader frontend test impact (the panel is imported by the docking registry).

Run: `(cd synthi && npx vitest run src/components/docking-wm)`
Expected: no regressions from the panel rewrite.

- [ ] **Step 3:** Confirm a guardrail-clean tree (only the intended files changed; `synthi/Dockerfile`, `tasks/*.md`, `memory/`, `docker-compose.override.yml` remain untouched/local-only).

Run: `git status --porcelain`

- [ ] **Step 4:** Hand back for the live visual check (user runs the frontend): open the Programs panel → Library shows running cards (with a live DBeaver/Postman thumbnail) + idle tiles; the `Store` button pushes the Store view; the filter strip scrolls horizontally on wheel with edge fades and the navbar thumb; the program list scrolls with the standard vectant scrollbar; install flows route through the detail/consent view. Provide a 1–2 sentence recap.

---

## Self-Review

**Spec coverage:**
- Library-first sidebar + in-sidebar Store → Tasks 6, 9, 10 (shell `view` state). ✓
- Hybrid running cards + live thumbnail → Tasks 3, 4. ✓
- Idle launch tiles + Browse-store tile → Tasks 5, 6. ✓
- "Run a command" removed → Task 10 (no command form). ✓
- Store order (logo → search → manifest/publish → filters → grid) → Task 9. ✓
- Filter strip = navbar scrollbar + wheel→horizontal + edge fade → Task 2. ✓
- Vertical list = regular global vectant scrollbar → no `.no-scrollbar` on the LibraryView/StoreView `overflow-y-auto` bodies (Tasks 6, 9). ✓
- 2-up store tiles, verified vs community → Task 7. ✓
- Detail + consent (scopes prominent, hosted framing) → Task 8. ✓
- Hosted-app model copy ("runs hosted in your workspace") → Task 8. ✓
- IA mapping (manifest/publish/marketplace → Store; detected → Library banner; recent → idle tiles) → Tasks 6, 9, 10. ✓
- Vectant visual tokens (gradient shell, rim-glow, brand gradient sparingly) → Task 1 + applied throughout. ✓
- Role gating preserved → Tasks 5, 7, 9 (`canManage`). ✓
- Existing tests migrated for the new IA → Task 10. ✓

**Placeholder scan:** Task 10 deliberately elides unchanged handler bodies with explicit "copy verbatim from the current file" instructions (not new code — re-homed existing code) and names exactly what to copy. All NEW code is shown in full. No "TBD"/"handle errors"/vague steps.

**Type/name consistency:** Prop names are consistent across tasks — `slug`, `session`, `install`, `item`, `canManage`, `onOpenStore`, `onOpenSession`, `onStop`, `onRestart`, `onLaunchInstall`, `onScaffold`, `onLaunchDetected`, `onInstallManifest`, `onPublish`, `onInstallPublished`, `onApprove`, `requestedScopes`, `consentItem`, `busy`. `data-testid`s preserved from the old suite: `install-from-manifest`, `publish-program`, `marketplace-item-*`, `install-published-*`, `verified-badge-*`, `launch-install-*`, `scaffold-*`, `detected-program`, `launch-detected`, `consent-prompt`, `approve-consent`; new ones added: `open-store`, `store-back`, `browse-store-tile`, `running-open/stop/restart-*`, `filter-chip-*`, `filter-scroller`, `detail-install`, `detail-back`.
