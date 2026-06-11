'use client';

/**
 * @fileoverview Docking system component showcase / playground.
 *
 * A standalone page for visually testing the docking components
 * without the full workspace overhead. Access at /workspace/docking-demo.
 */

import { useState, useEffect, useCallback } from 'react';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { store } from '@/redux/store';
import { DockingProvider } from '@/components/docking-wm/components/DockingProvider';
import { DockingContainer } from '@/components/docking-wm/components/DockingContainer';
import { LayoutPresetPicker } from '@/components/docking-wm/components/LayoutPresetPicker';
import { LayoutDebugOverlay } from '@/components/docking-wm/components/LayoutDebugOverlay';
import { registerPanel } from '@/components/docking-wm/state/panel-registry-core';
import { setLayout, selectLayout } from '@/components/docking-wm/state/layout-slice';
import { createLayoutFromPreset } from '@/components/docking-wm/panels/layout-presets';
import '@/components/docking-wm/styles/docking.css';

// ── Mock panels for demo ──
function MockPanel({ title, color }) {
  return (
    <div
      className="flex h-full w-full items-center justify-center text-sm"
      style={{ background: color || '#111', color: '#888' }}
    >
      {title || 'Panel'}
    </div>
  );
}

// Register mock panels
['explorer', 'search', 'git', 'extensions', 'editor', 'terminal', 'chat', 'problems', 'output', 'preview'].forEach((type) => {
  registerPanel({
    panelType: type,
    displayName: type.charAt(0).toUpperCase() + type.slice(1),
    icon: 'box',
    category: 'demo',
    component: () => <MockPanel title={type} color={`hsl(${type.length * 40}, 30%, 12%)`} />,
    allowMultiple: type === 'editor' || type === 'terminal',
    defaultLocation: 'center',
    closable: true,
  });
});

function DemoInner() {
  const dispatch = useDispatch();
  const layout = useSelector(selectLayout);
  const [activePreset, setActivePreset] = useState('classic');

  const handlePresetSelect = useCallback(
    (presetId) => {
      const newLayout = createLayoutFromPreset(presetId);
      dispatch(setLayout(newLayout));
      setActivePreset(presetId);
    },
    [dispatch],
  );

  // Initialize with classic layout if empty
  if (!layout?.rootId) {
    const initial = createLayoutFromPreset('classic');
    dispatch(setLayout(initial));
  }

  return (
    <div className="flex h-screen flex-col bg-[#09090b] text-[#D7DAE0]">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-[#1a1a1e] px-4 py-2">
        <h1 className="text-sm font-medium text-white">
          Docking WM Demo
        </h1>
        <span className="text-[10px] text-zinc-500">
          Ctrl+Shift+D for debug overlay
        </span>
      </div>

      {/* Preset picker */}
      <div className="border-b border-[#1a1a1e] px-4 py-3">
        <LayoutPresetPicker
          activePresetId={activePreset}
          onSelect={handlePresetSelect}
          showConfirm={false}
        />
      </div>

      {/* Docking area */}
      <div className="flex-1 min-h-0">
        <DockingProvider workspaceSlug="demo">
          <DockingContainer />
        </DockingProvider>
      </div>

      <LayoutDebugOverlay />
    </div>
  );
}

export default function DockingDemoPage() {
  // Browser-only playground: the docking UI touches window/ResizeObserver during
  // render, which breaks `next build` static prerender of /workspace/docking-demo.
  // Render client-side only — server render (build SSG + on-demand SSR) yields null,
  // then the demo mounts after hydration (matching null → no hydration mismatch).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <Provider store={store}>
      <DemoInner />
    </Provider>
  );
}
