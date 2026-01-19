'use client';

import React from 'react';
import { EMULATOR_STATES } from './emulatorStates';

function StatusBar() {
  return (
    <div className="h-7 px-3 flex items-center justify-between text-[11px] text-gray-200 bg-black/40">
      <div className="flex items-center gap-2">
        <div className="w-6 h-2 rounded bg-white/30" />
        <div className="w-4 h-2 rounded bg-white/20" />
      </div>
      <div className="flex items-center gap-2">
        <div className="w-4 h-2 rounded bg-white/20" />
        <div className="w-5 h-2 rounded bg-white/30" />
      </div>
    </div>
  );
}

function HomeScreenMock() {
  const icons = Array.from({ length: 12 }).map((_, idx) => idx);
  return (
    <div className="h-full w-full bg-gradient-to-b from-[#0b0b10] to-[#050506]">
      <StatusBar />
      <div className="p-4">
        <div className="text-xs text-gray-300 mb-3">Synthi Android</div>
        <div className="grid grid-cols-4 gap-3">
          {icons.map((i) => (
            <div key={i} className="flex flex-col items-center gap-1">
              <div className="w-10 h-10 rounded-xl bg-white/10 border border-white/10" />
              <div className="h-2 w-8 rounded bg-white/10" />
            </div>
          ))}
        </div>
      </div>

      {/* Dock */}
      <div className="absolute bottom-0 left-0 right-0 p-3">
        <div className="mx-auto max-w-[220px] bg-white/5 border border-white/10 rounded-2xl p-2 flex items-center justify-between">
          <div className="w-8 h-8 rounded-xl bg-white/10" />
          <div className="w-8 h-8 rounded-xl bg-white/10" />
          <div className="w-8 h-8 rounded-xl bg-white/10" />
          <div className="w-8 h-8 rounded-xl bg-white/10" />
        </div>
      </div>
    </div>
  );
}

function BootingScreen({ message }) {
  return (
    <div className="h-full w-full bg-black flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-full border-2 border-white/20 border-t-white/80 animate-spin" />
        <div className="text-xs text-gray-300 tracking-wide text-center px-4 max-w-[80%] break-words">
          {message || 'booting…'}
        </div>
      </div>
    </div>
  );
}

function MessageScreen({ title, subtitle }) {
  return (
    <div className="h-full w-full bg-black flex items-center justify-center">
      <div className="px-5 text-center">
        <div className="text-sm text-gray-200 mb-1">{title}</div>
        {subtitle ? <div className="text-xs text-gray-400">{subtitle}</div> : null}
      </div>
    </div>
  );
}

function Ripple({ x, y, onComplete }) {
  const onCompleteRef = React.useRef(onComplete);
  onCompleteRef.current = onComplete;

  React.useEffect(() => {
    const timer = setTimeout(() => {
      if (onCompleteRef.current) {
        onCompleteRef.current();
      }
    }, 600);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className="absolute bg-white/30 rounded-full pointer-events-none animate-ping origin-center"
      style={{
        left: x,
        top: y,
        width: 40,
        height: 40,
        transform: 'translate(-50%, -50%)',
      }}
    />
  );
}

const KEY_MAP = {
  // We will mostly rely on explicit checks in the helper function below
  // to avoid any dictionary lookup issues, but keeping this for fallbacks.
  'Tab': 'TAB',
  'Escape': 'BACK',
  'PageUp': 'PAGE_UP',
  'PageDown': 'PAGE_DOWN',
  'End': 'MOVE_END',
  'Home': 'MOVE_HOME',
};

// Helper to reliably map browser events to Android KeyCodes
function getAndroidKeycode(e) {
    const k = e.key;
    const c = e.code;

    // Navigation (Explicit checks)
    if (k === 'ArrowUp' || c === 'ArrowUp') return 'DPAD_UP';
    if (k === 'ArrowDown' || c === 'ArrowDown') return 'DPAD_DOWN';
    if (k === 'ArrowLeft' || c === 'ArrowLeft') return 'DPAD_LEFT';
    if (k === 'ArrowRight' || c === 'ArrowRight') return 'DPAD_RIGHT';
    if (k === 'Enter' || c === 'Enter' || c === 'NumpadEnter') return 'ENTER';
    if (k === 'Tab' || c === 'Tab') return 'TAB';
    if (k === 'Escape' || c === 'Escape') return 'BACK';

    // Editing (Explicit checks)
    if (k === 'Backspace' || c === 'Backspace') return 'DEL';
    if (k === 'Delete' || c === 'Delete') return 'FORWARD_DEL';

    // Map Lookup Fallback
    return KEY_MAP[k] || KEY_MAP[c];
}

export default function EmulatorScreen({
  state,
  errorMessage,
  sessionId,
  videoRef,
  canvasRef,
  mediaStream,
  bootStatus,
}) {
  // All hooks MUST be called before any conditional returns (React Rules of Hooks)
  const pointerStateRef = React.useRef(null);
  const containerRef = React.useRef(null);
  const [ripples, setRipples] = React.useState([]);

  const hasVideoTrack =
    !!mediaStream &&
    typeof mediaStream.getVideoTracks === 'function' &&
    mediaStream.getVideoTracks().length > 0;

  // Debug effect - logs streaming state (safe because it's before conditional returns)
  React.useEffect(() => {
    if (state === EMULATOR_STATES.STREAMING) {
      console.debug('[EmulatorScreen] STREAMING render', { 
        hasVideoTrack, 
        mediaStreamId: mediaStream?.id,
        videoTracks: mediaStream?.getVideoTracks?.()?.length ?? 'n/a',
      });
    }
  }, [state, hasVideoTrack, mediaStream]);

  // CRITICAL: Attach the mediaStream to the video element
  React.useEffect(() => {
    const video = videoRef?.current;
    if (!video) return;
    
    if (mediaStream && hasVideoTrack) {
      console.debug('[EmulatorScreen] Attaching mediaStream to video element', { 
        streamId: mediaStream.id,
        currentSrc: video.srcObject?.id 
      });
      
      // Only update if different stream
      if (video.srcObject !== mediaStream) {
        video.srcObject = mediaStream;
        // Ensure playback starts
        video.play().catch(err => {
          console.warn('[EmulatorScreen] video.play() rejected:', err.message);
        });
      }
    } else if (!mediaStream && video.srcObject) {
      // Clear when stream is removed
      video.srcObject = null;
    }
  }, [mediaStream, hasVideoTrack, videoRef]);

  // Early return for OFF state
  if (state === EMULATOR_STATES.OFF) {
    return <div className="h-full w-full bg-black" />;
  }

  const emitInput = (payload) => {
    try {
      if (!sessionId) return;
      if (typeof window === 'undefined' || !window.dispatchEvent) return;
      window.dispatchEvent(new CustomEvent('synthi:emulator-input', { detail: { sessionId, ...payload } }));
    } catch (_) {
      // ignore
    }
  };

  /**
   * Convert client coordinates to video coordinates.
   * The video is rendered with object-fit: contain,
   * so we compute the rendered size and letterbox offset before scaling.
   */
  const clientToVideoCoords = (el, clientX, clientY) => {
    const rect = el.getBoundingClientRect();
    const videoW = el.videoWidth || 1;
    const videoH = el.videoHeight || 1;

    // Since we use css centering (flex) and max-w/h, the rect matches the visible video.
    // No manual letterbox offset calculation needed.
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;

    // Scale to video resolution
    const videoX = (relX / rect.width) * videoW;
    const videoY = (relY / rect.height) * videoH;

    // Clamp to valid range
    return {
      x: Math.max(0, Math.min(videoW - 1, Math.round(videoX))),
      y: Math.max(0, Math.min(videoH - 1, Math.round(videoY))),
      videoW,
      videoH,
      viewW: rect.width,
      viewH: rect.height,
    };
  };

  const onPointerDown = (e) => {
    // Focus container to capture keyboard input
    containerRef.current?.focus({ preventScroll: true });

    const el = e.currentTarget;
    const coords = clientToVideoCoords(el, e.clientX, e.clientY);
    pointerStateRef.current = { ...coords, t: Date.now(), clientX: e.clientX, clientY: e.clientY };
    
    // Add client-side prediction ripple
    const rect = el.getBoundingClientRect();
    const rippleX = e.clientX - rect.left;
    const rippleY = e.clientY - rect.top;
    const id = Date.now();
    setRipples(prev => [...prev, { id, x: rippleX, y: rippleY }]);

    try { el.setPointerCapture?.(e.pointerId); } catch (_) {}
  };

  const onPointerUp = (e) => {
    const el = e.currentTarget;
    const st = pointerStateRef.current;
    pointerStateRef.current = null;
    if (!st) return;

    const coords = clientToVideoCoords(el, e.clientX, e.clientY);
    
    // Calculate distance in client space (for gesture detection)
    const dx = e.clientX - st.clientX;
    const dy = e.clientY - st.clientY;
    const dist = Math.hypot(dx, dy);
    const dur = Math.max(0, Date.now() - st.t);

    if (dist < 8 && dur < 250) {
      // Tap - use start coordinates
      // Note: Coordinates are already mapped to video resolution by clientToVideoCoords.
      // We do NOT send viewW/viewH to avoid double-scaling in the backend.
      emitInput({ type: 'tap', x: st.x, y: st.y, videoW: st.videoW, videoH: st.videoH });
    } else {
      // Swipe - use start and end coordinates
      emitInput({ type: 'swipe', x: st.x, y: st.y, x2: coords.x, y2: coords.y, durationMs: dur, videoW: coords.videoW, videoH: coords.videoH });
    }
  };

  const onKeyDown = (e) => {
    // Debug log to confirm key capture
    console.debug('[EmulatorScreen] Key:', e.key, 'Session:', sessionId);

    if (!sessionId) {
        console.warn('[EmulatorScreen] No sessionId, ignoring input');
        return;
    }

    // 1. Special Mappings (e.g. System HOME with Modifier)
    if (e.key === 'Home' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      emitInput({ type: 'key', keycode: 'HOME' });
      return;
    }

    // 2. Mapped Keys (using robust helper)
    const mappedCode = getAndroidKeycode(e);
    
    // Debug log to trace exactly what is matched
    if (mappedCode || e.key === 'ArrowUp' || e.key === 'Backspace' || e.key === 'Enter') {
         console.debug('[EmulatorScreen] Key Mapping:', { key: e.key, code: e.code, mapped: mappedCode });
    }

    if (mappedCode) {
      e.preventDefault();
      emitInput({ type: 'key', keycode: mappedCode });
      return;
    }

    // 3. Printable Characters & Text Injection
    // Ignore standalone modifier keys
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) {
      return;
    }

    // Ignore command combos (Ctrl+C, Alt+Tab, etc), but allow Shift for capitals.
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }

    // Single character printables
    if (e.key.length === 1) {
       // Prevent scrolling for Space, otherwise let browser handle it
      if (e.key === ' ') {
        e.preventDefault();
      }
      emitInput({ type: 'text', text: e.key });
      return;
    }
  };

  const onPaste = (e) => {
    if (!sessionId) return;
    const text = e.clipboardData?.getData('text') ?? '';
    if (text.length > 0) {
      e.preventDefault();
      emitInput({ type: 'text', text });
    }
  };

  if (state === EMULATOR_STATES.BOOTING) {
    return <BootingScreen message={bootStatus} />;
  }

  if (state === EMULATOR_STATES.IDLE) {
    return <HomeScreenMock />;
  }

  if (state === EMULATOR_STATES.NO_APP) {
    return <MessageScreen title="No app running" subtitle="Start an app to preview it here." />;
  }

  // Ensure container gets focus when clicking anywhere in the area
  const onContainerClick = (e) => {
    if (containerRef.current) {
        containerRef.current.focus({ preventScroll: true });
    }
  };

  if (state === EMULATOR_STATES.STREAMING) {
    return (
      <div 
        ref={containerRef}
        className="h-full w-full bg-black relative flex items-center justify-center outline-none focus:ring-1 focus:ring-green-500/50" 
        tabIndex={0} 
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onClick={onContainerClick}
      >
        {/* Video element - uses flex centering and max dimensions to strictly match aspect ratio without math */}
        <video
          ref={videoRef}
          className={hasVideoTrack ? "max-w-full max-h-full touch-none" : "hidden"}
          style={{ display: hasVideoTrack ? 'block' : 'none' }}
          muted
          playsInline
          autoPlay
          tabIndex={-1}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        />

        {!hasVideoTrack && (
          <div className="absolute inset-0 flex items-center justify-center">
            <MessageScreen title="Waiting for device stream…" subtitle="No video track yet." />
          </div>
        )}

        {/* Hidden canvas for future use */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Client Prediction: Render input ripples overlay */}
        {ripples.map(r => (
          <Ripple 
            key={r.id} 
            x={r.x} 
            y={r.y} 
            onComplete={() => setRipples(prev => prev.filter(rx => rx.id !== r.id))} 
          />
        ))}
      </div>
    );
  }

  if (state === EMULATOR_STATES.ERROR) {
    return <MessageScreen title="Emulator error" subtitle={errorMessage || 'Something went wrong.'} />;
  }

  // Fallback (should not happen)
  return <MessageScreen title="Unknown state" subtitle={String(state)} />;
}
