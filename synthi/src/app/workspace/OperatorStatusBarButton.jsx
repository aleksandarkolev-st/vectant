'use client';

// StatusBar trigger for the operator console. Mounts OperatorDialog
// lazily on open so the underlying WS isn't created until someone
// actually wants the kill switch.

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import OperatorDialog from './[slug]/operator/OperatorDialog.jsx';

export default function OperatorStatusBarButton({ sessionId }) {
  const [open, setOpen] = useState(false);
  if (!sessionId) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer transition-colors hover:bg-[color:var(--bg-hover)]"
        title="Open operator console"
      >
        <ShieldCheck
          className="w-3.5 h-3.5"
          style={{ color: 'var(--text-secondary)' }}
          strokeWidth={2}
        />
        <span className="hidden 2xl:inline font-medium" style={{ color: 'var(--text-secondary)' }}>
          Operator
        </span>
      </button>
      <OperatorDialog sessionId={sessionId} open={open} onOpenChange={setOpen} />
    </>
  );
}
