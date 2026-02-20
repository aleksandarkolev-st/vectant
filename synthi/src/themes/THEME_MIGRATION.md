# Theme Migration — Remaining Hardcoded Colors

The theme engine infrastructure is complete. All global CSS (globals.css, editor-overrides.css)
and panel wrappers have been fully converted to CSS variables.

**~500 hardcoded color instances remain** in individual JSX components. These should be
migrated to CSS variables incrementally as each component is touched.

## Priority 1 — Critical (visible every session)

| Component | File | Approx. instances |
|-----------|------|-------------------|
| TopNav | `src/app/workspace/TopNav.jsx` | ~30 |
| ActivityBar | `src/app/workspace/ActivityBar.jsx` | ~10 |
| StatusBar | `src/app/workspace/StatusBar.jsx` | ~6 |
| Editor.jsx | `src/app/workspace/[slug]/Editor/Editor.jsx` | ~15 |
| page.jsx | `src/app/workspace/[slug]/page.jsx` | ~15 |
| FileTree | `src/app/workspace/[slug]/FileTree.jsx` | ~20 |
| FileItem | `src/app/workspace/[slug]/FileItem.jsx` | ~8 |
| SearchView | `src/app/workspace/[slug]/SearchView.jsx` | ~15 |
| TerminalPane | `src/app/workspace/TerminalPane.jsx` | ~10 |
| TerminalManager | `src/app/workspace/TerminalManager.jsx` | ~20 |

## Priority 2 — High (major panels)

| Component | File | Approx. instances |
|-----------|------|-------------------|
| AIChatWindow | `src/components/chat/AIChatWindow.jsx` | ~100+ |
| GitStatus | `src/components/git/GitStatus.jsx` | ~60 |
| ProblemsPanel | `src/components/analysis/ProblemsPanel.jsx` | ~30 |
| ExtensionSidebar | `src/components/extensions/ExtensionSidebar.jsx` | ~60 |
| DockingActivityBar | `src/components/docking-wm/components/DockingActivityBar.jsx` | ~15 |

## Priority 3 — Medium (secondary panels)

| Component | File | Approx. instances |
|-----------|------|-------------------|
| MergeConflictEditor | `src/components/git/MergeConflictEditor.jsx` | ~20 |
| ExtensionViewContainer | `src/components/extensions/ExtensionViewContainer.jsx` | ~30 |
| CodeServerPanel | `src/components/extensions/CodeServerPanel.jsx` | ~15 |
| LayoutPresetPicker | `src/components/docking-wm/components/LayoutPresetPicker.jsx` | ~12 |
| FloatingWindow | `src/components/docking-wm/components/FloatingWindow.jsx` | ~6 |

## Migration Pattern

Replace Tailwind arbitrary colors and palette classes:

```jsx
// Before
className="bg-[#09090b] text-[#f0f2f5] border-[#1c1d26]"
className="text-zinc-400 bg-zinc-800"
className="text-gray-300 bg-gray-700"

// After — use inline style with CSS vars
className="h-full w-full"
style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)', borderColor: 'var(--border-subtle)' }}
```

### Common Mappings

| Hardcoded | CSS Variable |
|-----------|-------------|
| `#09090b`, `#0a0b10`, `#08090d` | `var(--bg-app)` or `var(--bg-sidebar)` |
| `#0c0d12`, `#0d0e14` | `var(--bg-editor)` or `var(--bg-panel)` |
| `#18181b`, `#1c1d26`, `#1a1b24` | `var(--bg-elevated)` |
| `#327464` | `var(--accent-primary)` |
| `#3d8b78` | `var(--accent-secondary)` |
| `#4a9d89`, `#4aba9a` | `var(--accent-tertiary)` |
| `#f0f2f5`, `#f4f5f8`, `#e4e4e7` | `var(--text-primary)` |
| `#9ba2b8`, `#a1a1aa`, `#a8adc0` | `var(--text-secondary)` |
| `#6b7089`, `#71717a`, `#5a6178` | `var(--text-muted)` |
| `#4a5066`, `#52525b`, `#3d4256` | `var(--text-disabled)` |
| `text-zinc-300/400` | `var(--text-secondary)` / `var(--text-muted)` |
| `text-gray-200/300` | `var(--text-primary)` / `var(--text-secondary)` |
| `bg-zinc-800/900` | `var(--bg-elevated)` |
