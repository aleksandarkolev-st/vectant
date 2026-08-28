'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Largest scale that fits a baseWidth×baseHeight box inside a
 * containerWidth×containerHeight box, preserving aspect ratio (letterbox).
 * Returns 1 for any missing/zero dimension.
 */
export function computeFitScale(containerWidth, containerHeight, baseWidth, baseHeight) {
  if (!containerWidth || !containerHeight || !baseWidth || !baseHeight) return 1;
  return Math.min(containerWidth / baseWidth, containerHeight / baseHeight);
}

const SANDBOX = 'allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads';

/**
 * Renders an iframe at a fixed base size and CSS-scales it to fit (zoom) the
 * container it lives in — the web-iframe equivalent of noVNC's resize=scale.
 * Used for the App tab of container GUI programs (DBeaver/KasmVNC, Portainer/web,
 * …) so every GUI program zooms to fit the docked/undocked tab uniformly.
 */
export default function ScaleToFitFrame({ src, title = 'app', baseWidth = 1280, baseHeight = 800 }) {
  const containerRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const update = () => setScale(computeFitScale(el.clientWidth, el.clientHeight, baseWidth, baseHeight));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [baseWidth, baseHeight]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-hidden relative"
      style={{ background: 'var(--bg-editor)' }}
    >
      <iframe
        title={title}
        src={src}
        sandbox={SANDBOX}
        allow="clipboard-read; clipboard-write"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: `${baseWidth}px`,
          height: `${baseHeight}px`,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: 'center center',
          border: 0,
        }}
      />
    </div>
  );
}
