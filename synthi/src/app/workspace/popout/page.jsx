'use client';

/**
 * @fileoverview Next.js route for pop-out windows.
 *
 * When the docking system opens `window.open('/workspace/popout?tabId=...')`,
 * this page loads in the child window, connects back to the parent via
 * BroadcastChannel, and renders the requested panel.
 *
 * URL params:
 *  - tabId     : Tab ID to render
 *  - panelType : Panel type fallback
 *  - windowId  : Unique popout window identifier
 */

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Provider } from 'react-redux';
import { store } from '@/redux/store';
import { PopoutWindowContent } from '@/components/docking-wm/components';
import '@/components/docking-wm/styles/docking.css';

function PopoutPageInner() {
  const params = useSearchParams();
  const tabId = params.get('tabId');
  const panelType = params.get('panelType');
  const windowId = params.get('windowId');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Set the document title to something useful
    document.title = `Vectant ADE — ${panelType || 'Panel'}`;

    // Signal parent that the popout window is ready
    try {
      const bc = new BroadcastChannel('synthi-docking-popout');
      bc.postMessage({
        type: 'popout:ready',
        windowId,
        tabId,
        panelType,
      });
      bc.close();
    } catch {
      // BroadcastChannel may not be available
    }

    setReady(true);

    // Clean up on window close
    const handleUnload = () => {
      try {
        const bc = new BroadcastChannel('synthi-docking-popout');
        bc.postMessage({
          type: 'popout:closing',
          windowId,
          tabId,
        });
        bc.close();
      } catch {
        // ignore
      }
    };

    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [tabId, panelType, windowId]);

  if (!tabId || !panelType) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#09090b] text-zinc-400 text-sm">
        Missing panel information. Close this window and try again.
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#09090b] text-zinc-500 text-xs">
        Connecting to workspace…
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#09090b] text-[#D7DAE0]">
      <PopoutWindowContent
        tabId={tabId}
        panelType={panelType}
        windowId={windowId}
      />
    </div>
  );
}

export default function PopoutPage() {
  return (
    <Provider store={store}>
      <Suspense
        fallback={
          <div className="flex h-screen items-center justify-center bg-[#09090b] text-zinc-500 text-xs">
            Loading…
          </div>
        }
      >
        <PopoutPageInner />
      </Suspense>
    </Provider>
  );
}
