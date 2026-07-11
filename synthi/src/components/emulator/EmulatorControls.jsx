'use client';

import React from 'react';
import { Button } from '@/components/ui/button';

export default function EmulatorControls({
  onPower,
  onHome,
  onRotate,
  disabled = false,
}) {
  return (
    <div className="flex items-center justify-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--surface-panel-subtle)] p-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="th-btn-ghost h-8 border-[var(--border-subtle)] text-[var(--text-secondary)]"
        onClick={onPower}
        disabled={disabled}
      >
        Power
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="th-btn-ghost h-8 border-[var(--border-subtle)] text-[var(--text-secondary)]"
        onClick={onHome}
        disabled={disabled}
      >
        Home
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="th-btn-ghost h-8 border-[var(--border-subtle)] text-[var(--text-secondary)]"
        onClick={onRotate}
        disabled={disabled}
      >
        Rotate
      </Button>
    </div>
  );
}
