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
    <div className="flex items-center justify-center gap-2 p-2 border-t border-[#1a1a1e] bg-[#09090b]">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors"
        onClick={onPower}
        disabled={disabled}
      >
        Power
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors"
        onClick={onHome}
        disabled={disabled}
      >
        Home
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors"
        onClick={onRotate}
        disabled={disabled}
      >
        Rotate
      </Button>
    </div>
  );
}
