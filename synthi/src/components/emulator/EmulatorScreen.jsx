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
  videoRef,
  canvasRef,
  mediaStream,
  frameDataUrl,
}) {
  // Future-proofing:
  // - When real streaming is added, the backend will supply frames via WebRTC.
  // - Those frames can be injected here by attaching `videoRef` or `canvasRef`.

  if (state === EMULATOR_STATES.OFF) {
    return <div className="h-full w-full bg-black" />;
  }

  const hasVideoTrack =
    !!mediaStream &&
    typeof mediaStream.getVideoTracks === 'function' &&
    mediaStream.getVideoTracks().length > 0;

  // If a MediaStream exists AND it has a video track, prefer rendering the real streaming surface.
  // Otherwise we show an explicit placeholder (instead of a confusing black screen).
  if (hasVideoTrack && state !== EMULATOR_STATES.ERROR) {
    return (
      <div className="h-full w-full bg-black relative">
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-contain"
          muted
          playsInline
          autoPlay
        />

        <div className="absolute inset-0 pointer-events-none">
          <canvas ref={canvasRef} className="hidden" />
        </div>
      </div>
    );
  }

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
      <div className="h-full w-full bg-black relative">
        {frameDataUrl ? (
          <img
            src={frameDataUrl}
            alt="Emulator preview"
            className="absolute inset-0 h-full w-full object-contain"
          />
        ) : null}
        <video
          ref={videoRef}
          className={hasVideoTrack ? "absolute inset-0 h-full w-full object-contain" : "hidden"}
          muted
          playsInline
          autoPlay
        />

        {!hasVideoTrack && !frameDataUrl ? (
          <MessageScreen title="Waiting for device stream…" subtitle="Streaming connected; no video track yet." />
        ) : null}

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
