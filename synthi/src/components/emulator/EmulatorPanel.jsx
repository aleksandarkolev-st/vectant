'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  onClose,
}) {
  const [state, setState] = useState(() => defaultState || getInitialEmulatorState());
  const [orientation, setOrientation] = useState('portrait');
  const [errorMessage, setErrorMessage] = useState('');

  // Future-proof: keep refs ready for real streaming.
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Fake boot completion.
  useEffect(() => {
    if (state !== EMULATOR_STATES.BOOTING) return;
    const id = window.setTimeout(() => {
      setState(EMULATOR_STATES.IDLE);
    }, bootDurationMs);
    return () => window.clearTimeout(id);
  }, [state, bootDurationMs]);

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
        return 'Streaming (placeholder)';
      case EMULATOR_STATES.ERROR:
        return 'Error';
      default:
        return 'Unknown';
    }
  }, [state]);

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
          <div className="text-[11px] text-gray-400">State: {statusText}</div>
        </div>

        {/*
          UI-only: we intentionally do NOT include any real device selection,
          SDK status, or build controls here.
        */}
        <div className="flex items-center gap-2">
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
              videoRef={videoRef}
              canvasRef={canvasRef}
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
