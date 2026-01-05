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

  const getGeometry = (el) => {
    try {
      const r = el.getBoundingClientRect();
      return {
        viewW: r.width,
        viewH: r.height,
        videoW: el.videoWidth || 0,
        videoH: el.videoHeight || 0,
      };
    } catch (_) {
      return { viewW: 0, viewH: 0, videoW: 0, videoH: 0 };
    }
  };

  const onPointerDown = (e) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    pointerStateRef.current = { x, y, t: Date.now() };
    try { el.setPointerCapture?.(e.pointerId); } catch (_) {}
  };

  const onPointerUp = (e) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x2 = e.clientX - r.left;
    const y2 = e.clientY - r.top;
    const st = pointerStateRef.current;
    pointerStateRef.current = null;
    if (!st) return;

    const dx = x2 - st.x;
    const dy = y2 - st.y;
    const dist = Math.hypot(dx, dy);
    const dur = Math.max(0, Date.now() - st.t);
    const geo = getGeometry(el);

    if (dist < 8 && dur < 250) {
      emitInput({ type: 'tap', x: st.x, y: st.y, ...geo });
    } else {
      emitInput({ type: 'swipe', x: st.x, y: st.y, x2, y2, durationMs: dur, ...geo });
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
    // Debug: capture a frame to see what's actually in the video
    const captureFrame = () => {
      try {
        const video = videoRef.current;
        if (!video || video.videoWidth === 0) return;
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(video.videoWidth, 320);
        canvas.height = Math.min(video.videoHeight, 640);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        // Check if the frame is all black
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        let nonBlackPixels = 0;
        let totalPixels = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 10 || data[i+1] > 10 || data[i+2] > 10) {
            nonBlackPixels++;
          }
        }
        const pct = ((nonBlackPixels / totalPixels) * 100).toFixed(1);
        console.log(`[video-debug] Frame analysis: ${nonBlackPixels}/${totalPixels} non-black pixels (${pct}%)`);
        // Show the frame in a new window for debugging
        const dataUrl = canvas.toDataURL('image/png');
        console.log('[video-debug] Frame captured, opening in new tab...');
        const w = window.open('', '_blank');
        if (w) {
          w.document.write(`<img src="${dataUrl}" style="max-width:100%;border:2px solid red;"/><p>Non-black: ${pct}%</p>`);
        }
      } catch (e) {
        console.error('[video-debug] Frame capture failed:', e);
      }
    };

    return (
      <div className="h-full w-full bg-black relative flex items-center justify-center" tabIndex={0} onKeyDown={onKeyDown}>
        <video
          ref={videoRef}
          className={hasVideoTrack ? "max-h-full max-w-full object-contain touch-none" : "hidden"}
          muted
          playsInline
          autoPlay
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        />

        {!hasVideoTrack ? (
          <MessageScreen title="Waiting for device stream…" subtitle="No video track yet." />
        ) : null}

        {/* Debug overlay - shows video element state */}
        {hasVideoTrack && (
          <div className="absolute bottom-0 left-0 right-0 p-1 bg-black/70 text-[10px] text-green-400 font-mono pointer-events-none z-10 flex justify-between items-center">
            <span>
              video: {videoRef.current?.videoWidth || 0}x{videoRef.current?.videoHeight || 0} | 
              readyState={videoRef.current?.readyState || 0} | 
              {videoRef.current?.paused ? 'paused' : 'playing'}
            </span>
            <button 
              onClick={captureFrame} 
              className="pointer-events-auto px-2 py-0.5 bg-blue-600 rounded text-white text-[9px] hover:bg-blue-500"
            >
              Capture Frame
            </button>
          </div>
        )}

        {/*
          Future injection point (do not use yet):
          - videoRef can attach to a <video> fed by WebRTC.
          - canvasRef can attach to a <canvas> for decoded frames.
        */}
        <div className="absolute inset-0 pointer-events-none">
          <canvas ref={canvasRef} className="hidden" />
        </div>
      </div>
    );
  }

  if (state === EMULATOR_STATES.ERROR) {
    return <MessageScreen title="Emulator error" subtitle={errorMessage || 'Something went wrong.'} />;
  }

  // Fallback (should not happen)
  return <MessageScreen title="Unknown state" subtitle={String(state)} />;
}
