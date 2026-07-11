'use client';

import React from 'react';

export default function EmulatorFrame({
  orientation = 'portrait',
  responsive = false,
  children,
}) {
  const isLandscape = orientation === 'landscape';
  const frameStyle = {
    borderColor: 'color-mix(in srgb, var(--border-medium) 78%, transparent)',
    background:
      'linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 88%, white 4%), color-mix(in srgb, var(--bg-editor) 84%, black 16%))',
    boxShadow:
      'inset 0 1px 0 color-mix(in srgb, white 7%, transparent), 0 22px 54px -36px rgba(0, 0, 0, 0.9)',
  };
  const screenStyle = {
    background: 'var(--bg-editor)',
    borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)',
  };

  // When responsive (real streaming), let the video fill the space naturally
  if (responsive) {
    return (
      <div
        className="flex h-full w-full items-center justify-center p-2"
        style={{ background: 'var(--bg-app)' }}
      >
        <div 
          className={
            'relative flex-shrink-0 overflow-hidden rounded-[1.35rem] border ' +
            (isLandscape
              ? 'aspect-[19.5/9] h-auto max-h-full w-full max-w-full'
              : 'aspect-[9/19.5] h-full max-h-full w-auto max-w-full')
          }
          style={frameStyle}
        >
          <div className="absolute inset-[8px] overflow-hidden rounded-[1rem] border" style={screenStyle}>
            {children}
          </div>
          <div
            className="absolute left-1/2 top-[4px] h-[4px] w-12 -translate-x-1/2 rounded-full"
            style={{ background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)' }}
          />
        </div>
      </div>
    );
  }

  // Non-responsive standby mode keeps a stable preview size.
  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <div className="relative select-none">
        <div
          className={
            'relative overflow-hidden rounded-[1.5rem] border ' +
            (isLandscape
              ? 'aspect-[19.5/9] w-[420px] max-w-[70vw]'
              : 'aspect-[9/19.5] w-[280px] max-w-[70vw]')
          }
          style={frameStyle}
        >
          <div className="absolute inset-[10px] overflow-hidden rounded-[1.05rem] border" style={screenStyle}>
            {children}
          </div>

          <div
            className="absolute left-1/2 top-[6px] h-[5px] w-16 -translate-x-1/2 rounded-full"
            style={{ background: 'color-mix(in srgb, var(--text-primary) 10%, transparent)' }}
          />
        </div>
      </div>
    </div>
  );
}
