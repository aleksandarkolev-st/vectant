'use client';

import React from 'react';

export default function EmulatorFrame({
  orientation = 'portrait',
  children,
}) {
  const isLandscape = orientation === 'landscape';

  return (
    <div className="w-full h-full flex items-center justify-center p-4">
      {/*
        UI-only: this is just a phone-like frame.
        Aspect ratio is fixed to emulate a device viewport.
      */}
      <div
        className={
          "relative select-none transition-transform duration-200 " +
          (isLandscape ? 'rotate-90 scale-90' : '')
        }
      >
        <div
          className={
            "bg-[#0c0c0e] border border-[#1a1a1e] rounded-[2.25rem] shadow-sm overflow-hidden " +
            (isLandscape ? 'aspect-[19.5/9] w-[420px] max-w-[70vw]' : 'aspect-[9/19.5] w-[280px] max-w-[70vw]')
          }
        >
          {/* Bezel */}
          <div className="absolute inset-0 bg-[#050506]" />

          {/* Screen cutout */}
          <div className="absolute inset-[10px] rounded-[1.75rem] bg-black overflow-hidden">
            {children}
          </div>

          {/* Speaker notch (decorative) */}
          <div className="absolute top-[6px] left-1/2 -translate-x-1/2 w-16 h-[5px] rounded-full bg-[#151519]" />
        </div>
      </div>
    </div>
  );
}
