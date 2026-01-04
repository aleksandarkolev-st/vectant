'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import EmulatorControls from './EmulatorControls';
import EmulatorFrame from './EmulatorFrame';
import EmulatorScreen from './EmulatorScreen';
import {
  EMULATOR_STATES,
  getInitialEmulatorState,
  nextStateOnHome,
  nextStateOnPower,
} from './emulatorStates';

/**
 * EmulatorPanel
 * UI-only Android emulator preview panel.
 *
 * IMPORTANT: This does not run Android.
 * It is a fake state machine + visuals designed to be replaced later
 * by a real streaming surface (WebRTC/canvas).
 */
export default function EmulatorPanel({
  title = 'Android Emulator (Preview)',
  defaultState,
  bootDurationMs = 1400,
  sessionId = null,
  mediaStream = null,
  forcedErrorMessage = '',
  onClose = null,
}) {
  const [state, setState] = useState(() => defaultState || getInitialEmulatorState());
  const [orientation, setOrientation] = useState('portrait');
  const [errorMessage, setErrorMessage] = useState('');
  const [workerStatus, setWorkerStatus] = useState(null);
  const [workerMessage, setWorkerMessage] = useState('');
  const [streamConnected, setStreamConnected] = useState(false);
  const lastEventAtRef = useRef(0);
  const capabilitiesRef = useRef(null);

  // Future-proof: keep refs ready for real streaming.
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Fake boot completion (UI-only mode).
  // When a real session is active, the worker stream drives state.
  useEffect(() => {
    if (sessionId) return;
    if (state !== EMULATOR_STATES.BOOTING) return;
    const id = window.setTimeout(() => {
      setState(EMULATOR_STATES.IDLE);
    }, bootDurationMs);
    return () => window.clearTimeout(id);
  }, [state, bootDurationMs, sessionId]);

  // If we have a media stream for a real session, ensure we render the streaming surface.
  useEffect(() => {
    if (!sessionId) return;
    if (!mediaStream) return;
    setState((prev) => (prev === EMULATOR_STATES.ERROR ? prev : EMULATOR_STATES.STREAMING));
  }, [sessionId, mediaStream]);

  // Attach WebRTC media stream (if any) to the video element.
  // Include `state` so we rerun when the <video> element mounts (it only exists in STREAMING).
  useEffect(() => {
    if (!mediaStream) return;
    const el = videoRef.current;
    if (!el) return;
    try {
      if (el.srcObject !== mediaStream) {
        el.srcObject = mediaStream;
      }
      // Some browsers require an explicit play() call.
      const p = el.play?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // ignore
    }
  }, [mediaStream, state]);

  // If the parent reports a hard failure (e.g. compile promise rejected), surface it.
  useEffect(() => {
    if (!forcedErrorMessage) return;
    setErrorMessage(forcedErrorMessage);
    setState(EMULATOR_STATES.ERROR);
  }, [forcedErrorMessage]);

  const buildHelpfulError = useCallback((parsed) => {
    const base = parsed?.message || 'Mobile emulator job failed.';
    const line = parsed?.data?.error || '';
    const combined = [base, line].filter(Boolean).join('\n');

    // Best-effort actionable hints from known failure modes.
    if (/Android SDK not ready/i.test(combined)) {
      return `${base}\n\nCheck: Android SDK tools/system images are installed in the worker image.`;
    }
    if (/does not contain a Gradle Android build|missing settings\.gradle/i.test(combined)) {
      return `${base}\n\nCheck: your project needs a generated android/ Gradle project (bare RN/Expo prebuild).`;
    }
    if (/Unexpected lock protocol found in lock file|Could not open proj generic class cache|cache .* is corrupt\. Discarding\./i.test(combined)) {
      return `${base}\n\nCheck: the worker's Gradle cache appears corrupted/locked. Fix by using an isolated GRADLE_USER_HOME per job or clearing Gradle caches in the worker image.`;
    }
    if (/EBADENGINE|node:\s*v18\./i.test(combined)) {
      return `${base}\n\nCheck: worker Node version may be too old for your dependencies (some require Node 20+).`;
    }
    return combined;
  }, []);

  // Listen for worker events scoped to this sessionId.
  useEffect(() => {
    if (!sessionId || typeof window === 'undefined') return;

    const handler = (e) => {
      const detail = e?.detail || {};
      if (detail.sessionId !== sessionId) return;
      const line = detail.line;
      if (typeof line !== 'string') return;

      lastEventAtRef.current = Date.now();
      setStreamConnected(true);

      let parsed = null;
      try { parsed = JSON.parse(line); } catch (_) { parsed = null; }
      if (!parsed || typeof parsed !== 'object') return;

      if (parsed.type === 'mobile-status') {
        setWorkerStatus(parsed.status || null);
        setWorkerMessage(parsed.message || '');

        const s = String(parsed.status || '');
        if (s === 'error' || s === 'build-failed') {
          setErrorMessage(buildHelpfulError(parsed));
          setState(EMULATOR_STATES.ERROR);
          return;
        }

        if (s === 'running' || s === 'streaming' || s === 'done') {
          setErrorMessage('');
          setState(EMULATOR_STATES.STREAMING);
          return;
        }

        // Any other mobile status means we're still in the job pipeline.
        setErrorMessage('');
        setState(EMULATOR_STATES.BOOTING);
        return;
      }

      // Capability announcement (future-proof for real video + input)
      if (parsed.type === 'mobile-capabilities') {
        capabilitiesRef.current = parsed?.data || null;
        return;
      }

      // If we see strong error signals in logs, surface them.
      if (parsed.type === 'mobile-log') {
        const l = String(parsed.line || '');
        if (/Generated project does not contain a Gradle Android build|APK build failed/i.test(l)) {
          setErrorMessage(l);
          setState(EMULATOR_STATES.ERROR);
        }
      }
    };

    window.addEventListener('synthi:build-stream', handler);
    return () => window.removeEventListener('synthi:build-stream', handler);
  }, [sessionId, buildHelpfulError]);

  // Stream health check: if we haven't received any events recently while a job is active, show an error.
  useEffect(() => {
    if (!sessionId) return;
    // Gradle (especially Kotlin compile + dependency resolution) can be silent for minutes.
    // Treat silence as "possibly disconnected" but don't hard-fail the panel.
    const STREAM_SILENCE_TIMEOUT_MS = 5 * 60 * 1000;
    const id = window.setInterval(() => {
      const last = lastEventAtRef.current;
      if (!last) return;
      const ageMs = Date.now() - last;
      const active = workerStatus && workerStatus !== 'done' && workerStatus !== 'error' && workerStatus !== 'build-failed';
      if (active && ageMs > STREAM_SILENCE_TIMEOUT_MS) {
        setErrorMessage('Lost connection to the worker log stream. Try running the build again.');
        setStreamConnected(false);
        setState((prev) => (prev === EMULATOR_STATES.ERROR ? prev : EMULATOR_STATES.BOOTING));
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [sessionId, workerStatus]);

  const statusText = useMemo(() => {
    switch (state) {
      case EMULATOR_STATES.OFF:
        return 'Off';
      case EMULATOR_STATES.BOOTING:
        return 'Booting';
      case EMULATOR_STATES.IDLE:
        return 'Idle';
      case EMULATOR_STATES.NO_APP:
        return 'No app';
      case EMULATOR_STATES.STREAMING:
        return 'Streaming';
      case EMULATOR_STATES.ERROR:
        return 'Error';
      default:
        return 'Unknown';
    }
  }, [state]);

  const headerSubtitle = useMemo(() => {
    if (!sessionId) return `State: ${statusText}`;
    const sidShort = sessionId.length > 18 ? `${sessionId.slice(0, 9)}…${sessionId.slice(-6)}` : sessionId;
    const worker = workerMessage ? ` • ${workerMessage}` : '';
    return `State: ${statusText} • Session: ${sidShort}${worker}`;
  }, [sessionId, statusText, workerMessage]);

  const handlePower = () => {
    setErrorMessage('');
    setState((prev) => nextStateOnPower(prev));
  };

  const handleHome = () => {
    setErrorMessage('');
    setState((prev) => nextStateOnHome(prev));
  };

  const handleRotate = () => {
    setOrientation((prev) => (prev === 'portrait' ? 'landscape' : 'portrait'));
  };

  return (
    <div className="h-full w-full flex flex-col bg-[#0c0c0e]">
      {/* Header */}
      <div className="h-10 flex items-center justify-between px-3 border-b border-[#1a1a1e] bg-[#09090b]">
        <div className="min-w-0">
          <div className="text-sm text-gray-200 truncate">{title}</div>
          <div className="text-[11px] text-gray-400 truncate">{headerSubtitle}</div>
        </div>

        {/*
          UI-only: we intentionally do NOT include any real device selection,
          SDK status, or build controls here.
        */}
        <div className="flex items-center gap-2">
          <div className="text-[11px] text-gray-500">
            {sessionId ? (streamConnected ? 'Connected' : 'Connecting…') : 'UI-only'}
          </div>
          <div className="text-[11px] text-gray-500">UI-only</div>
          {typeof onClose === 'function' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 border-[#4b4b4b] bg-[#262626] hover:bg-[#2e2e2e] hover:border-emerald-500 hover:text-emerald-400 text-gray-200 transition-colors"
              onClick={onClose}
              aria-label="Close emulator preview"
            >
              Close
            </Button>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        <EmulatorFrame orientation={orientation}>
          <div className="relative h-full w-full">
            <EmulatorScreen
              state={state}
              errorMessage={errorMessage}
              sessionId={sessionId}
              videoRef={videoRef}
              canvasRef={canvasRef}
              mediaStream={mediaStream}
            />
          </div>
        </EmulatorFrame>
      </div>

      <EmulatorControls
        onPower={handlePower}
        onHome={handleHome}
        onRotate={handleRotate}
        disabled={false}
      />

      {/*
        Developer note:
        - Future actions can drive state transitions, e.g.:
          - setState(EMULATOR_STATES.STREAMING) when a stream is negotiated
          - setState(EMULATOR_STATES.NO_APP) when no app is active
      */}
    </div>
  );
}
