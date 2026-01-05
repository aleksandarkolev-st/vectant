'use client';

import React from 'react';

export default function EmulatorFrame({
  orientation = 'portrait',
  responsive = false,
  children,
}) {
  const isLandscape = orientation === 'landscape';

  // When responsive (real streaming), let the video fill the space naturally
  if (responsive) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-black p-2">
        <div 
          className={
            "relative bg-[#0c0c0e] border-2 border-[#1a1a1e] rounded-[2rem] shadow-sm overflow-hidden flex-shrink-0 " +
            (isLandscape
              ? "w-full max-w-full h-auto max-h-full aspect-[19.5/9]"
              : "h-full max-h-full w-auto max-w-full aspect-[9/19.5]")
          }
        >
          {/* Screen area - let children fill */}
          <div className="absolute inset-[8px] rounded-[1.5rem] bg-black overflow-hidden">
            {children}
          </div>
          {/* Speaker notch (decorative) */}
          <div className="absolute top-[4px] left-1/2 -translate-x-1/2 w-12 h-[4px] rounded-full bg-[#151519]" />
        </div>
      </div>
    );
  }

  // Non-responsive (placeholder/mock) - fixed size
  return (
    <div className="w-full h-full flex items-center justify-center p-4">
      <div className="relative select-none">
        <div
          className={
            "bg-[#0c0c0e] border-2 border-[#1a1a1e] rounded-[2.25rem] shadow-sm overflow-hidden " +
            (isLandscape
              ? 'aspect-[19.5/9] w-[420px] max-w-[70vw]'
              : 'aspect-[9/19.5] w-[280px] max-w-[70vw]')
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
