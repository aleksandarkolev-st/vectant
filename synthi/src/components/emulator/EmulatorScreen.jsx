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

function BootingScreen() {
  return (
    <div className="h-full w-full bg-black flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-full border-2 border-white/20 border-t-white/80 animate-spin" />
        <div className="text-xs text-gray-300 tracking-wide">booting…</div>
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

export default function EmulatorScreen({
  state,
  errorMessage,
  sessionId,
  videoRef,
  canvasRef,
  mediaStream,
}) {
  // All hooks MUST be called before any conditional returns (React Rules of Hooks)
  const pointerStateRef = React.useRef(null);

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
   * Convert client coordinates to video coordinates, accounting for object-contain scaling.
   * The video element may be letterboxed/pillarboxed, so we need to:
   * 1. Calculate the actual rendered video size within the container
   * 2. Calculate the offset from letterboxing
   * 3. Map the click position to video pixel coordinates
   */
  const clientToVideoCoords = (el, clientX, clientY) => {
    const rect = el.getBoundingClientRect();
    const containerW = rect.width;
    const containerH = rect.height;
    const videoW = el.videoWidth || 1;
    const videoH = el.videoHeight || 1;

    // Calculate the scale factor for object-contain
    const containerAspect = containerW / containerH;
    const videoAspect = videoW / videoH;

    let renderedW, renderedH, offsetX, offsetY;

    if (containerAspect > videoAspect) {
      // Container is wider than video - letterboxed on sides (pillarboxed)
      renderedH = containerH;
      renderedW = containerH * videoAspect;
      offsetX = (containerW - renderedW) / 2;
      offsetY = 0;
    } else {
      // Container is taller than video - letterboxed on top/bottom
      renderedW = containerW;
      renderedH = containerW / videoAspect;
      offsetX = 0;
      offsetY = (containerH - renderedH) / 2;
    }

    // Get position relative to container
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;

    // Adjust for letterbox offset and scale to video resolution
    const videoX = ((relX - offsetX) / renderedW) * videoW;
    const videoY = ((relY - offsetY) / renderedH) * videoH;

    // Clamp to valid range
    return {
      x: Math.max(0, Math.min(videoW - 1, Math.round(videoX))),
      y: Math.max(0, Math.min(videoH - 1, Math.round(videoY))),
      videoW,
      videoH,
      viewW: containerW,
      viewH: containerH,
    };
  };

  const onPointerDown = (e) => {
    const el = e.currentTarget;
    const coords = clientToVideoCoords(el, e.clientX, e.clientY);
    pointerStateRef.current = { ...coords, t: Date.now(), clientX: e.clientX, clientY: e.clientY };
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
      emitInput({ type: 'tap', x: st.x, y: st.y, videoW: st.videoW, videoH: st.videoH, viewW: st.viewW, viewH: st.viewH });
    } else {
      // Swipe - use start and end coordinates
      emitInput({ type: 'swipe', x: st.x, y: st.y, x2: coords.x, y2: coords.y, durationMs: dur, videoW: coords.videoW, videoH: coords.videoH, viewW: coords.viewW, viewH: coords.viewH });
    }
  };

  const mapKey = (k) => {
    switch (k) {
      case 'Enter': return 'ENTER';
      case 'Backspace': return 'DEL';
      case 'Escape': return 'BACK';
      case 'Tab': return 'TAB';
      case 'ArrowUp': return 'DPAD_UP';
      case 'ArrowDown': return 'DPAD_DOWN';
      case 'ArrowLeft': return 'DPAD_LEFT';
      case 'ArrowRight': return 'DPAD_RIGHT';
      case ' ': return null;
      default: return null;
    }
  };

  const onKeyDown = (e) => {
    if (!sessionId) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (!k) return;

    // Printable single-character keys -> text.
    if (k.length === 1 && k !== '\n' && k !== '\r') {
      emitInput({ type: 'text', text: k });
      e.preventDefault();
      return;
    }

    const kc = mapKey(k);
    if (kc) {
      emitInput({ type: 'key', keycode: kc });
      e.preventDefault();
    }
  };

  if (state === EMULATOR_STATES.BOOTING) {
    return <BootingScreen />;
  }

  if (state === EMULATOR_STATES.IDLE) {
    return <HomeScreenMock />;
  }

  if (state === EMULATOR_STATES.NO_APP) {
    return <MessageScreen title="No app running" subtitle="Start an app to preview it here." />;
  }

  if (state === EMULATOR_STATES.STREAMING) {
    return (
      <div className="h-full w-full bg-black relative" tabIndex={0} onKeyDown={onKeyDown}>
        {/* Video element - fills container, maintains aspect ratio */}
        <video
          ref={videoRef}
          className={hasVideoTrack ? "absolute inset-0 w-full h-full object-contain touch-none" : "hidden"}
          muted
          playsInline
          autoPlay
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        />

        {!hasVideoTrack && (
          <MessageScreen title="Waiting for device stream…" subtitle="No video track yet." />
        )}

        {/* Hidden canvas for future use */}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    );
  }

  if (state === EMULATOR_STATES.ERROR) {
    return <MessageScreen title="Emulator error" subtitle={errorMessage || 'Something went wrong.'} />;
  }

  // Fallback (should not happen)
  return <MessageScreen title="Unknown state" subtitle={String(state)} />;
}
