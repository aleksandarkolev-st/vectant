'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Power, Home, RotateCcw, X, Minus, Plus } from 'lucide-react';
import EmulatorScreen from './EmulatorScreen';
import {
  EMULATOR_STATES,
  getInitialEmulatorState,
  nextStateOnHome,
  nextStateOnPower,
} from './emulatorStates';

/**
 * FloatingEmulatorWindow
 * 
 * A floating, draggable Android emulator frame that looks like a real device.
 * Controls are integrated inside the device bezel.
 * Uses fixed phone aspect ratio (9:19.5) - video will be fit inside with object-contain.
 */
export default function FloatingEmulatorWindow({
  defaultState,
  bootDurationMs = 1400,
  sessionId = null,
  mediaStream = null,
  forcedErrorMessage = '',
  onClose = null,
  initialPosition = null,
}) {
  // Emulator state
  const [state, setState] = useState(() => defaultState || getInitialEmulatorState());
  const [orientation, setOrientation] = useState('portrait');
  const [errorMessage, setErrorMessage] = useState('');
  const [workerStatus, setWorkerStatus] = useState(null);
  const [workerMessage, setWorkerMessage] = useState('');
  const [streamConnected, setStreamConnected] = useState(false);
  const lastEventAtRef = useRef(0);
  const capabilitiesRef = useRef(null);

  // Refs for video/canvas
  const videoRef = useRef(null);
  const canvasRef = useRef(null);

  // Floating state
  const [position, setPosition] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const containerRef = useRef(null);

  // Scale factor for resizing (0.5 to 1.5)
  const [scale, setScale] = useState(1.0);
  
  // Target height at scale 1.0 - width will be calculated from video aspect ratio
  const BASE_HEIGHT = 600;

  // Debug: WebRTC/media diagnostics
  const [webrtcDiagnostics, setWebrtcDiagnostics] = useState('');

  // Track video dimensions when stream loads - must be declared before getDeviceDimensions
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 });

  // Calculate device dimensions based on video aspect ratio and scale
  // If we have video dimensions, use those. Otherwise use a reasonable phone ratio.
  const getDeviceDimensions = useCallback(() => {
    const isLandscape = orientation === 'landscape';
    const targetHeight = Math.round(BASE_HEIGHT * scale);
    
    // Use actual video aspect ratio if available, else default phone ratio
    let aspectRatio = 9 / 16; // Default to 9:16 phone ratio
    if (videoDimensions.width > 0 && videoDimensions.height > 0) {
      aspectRatio = videoDimensions.width / videoDimensions.height;
    }
    
    const targetWidth = Math.round(targetHeight * aspectRatio);
    
    if (isLandscape) {
      return {
        width: targetHeight,  // swap
        height: targetWidth,
      };
    }
    return {
      width: targetWidth,
      height: targetHeight,
    };
  }, [orientation, scale, videoDimensions.width, videoDimensions.height]);

  const { width: deviceWidth, height: deviceHeight } = getDeviceDimensions();
  
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleLoadedMetadata = () => {
      if (video.videoWidth && video.videoHeight) {
        console.debug('[FloatingEmulator] Video dimensions:', video.videoWidth, 'x', video.videoHeight);
        setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
      }
    };

    // Also check periodically in case metadata event fires before we attach
    const checkDimensions = () => {
      if (video.videoWidth && video.videoHeight && 
          (videoDimensions.width !== video.videoWidth || videoDimensions.height !== video.videoHeight)) {
        setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
      }
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    const intervalId = setInterval(checkDimensions, 1000);

    // Initial check
    handleLoadedMetadata();

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      clearInterval(intervalId);
    };
  }, [videoDimensions.width, videoDimensions.height]);

  // Initialize position on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && position === null) {
      if (initialPosition) {
        setPosition(initialPosition);
      } else {
        // Default position: bottom-right corner with some padding
        const x = Math.max(20, window.innerWidth - deviceWidth - 60);
        const y = Math.max(20, window.innerHeight - deviceHeight - 100);
        setPosition({ x, y });
      }
    }
  }, [initialPosition, position]);

  // Constrain position when window is resized
  useEffect(() => {
    const handleResize = () => {
      if (!position) return;
      setPosition(prev => ({
        x: Math.max(0, Math.min(prev.x, window.innerWidth - 100)),
        y: Math.max(0, Math.min(prev.y, window.innerHeight - 50)),
      }));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [position]);

  // Dragging logic - drag from anywhere on the device bezel
  const handleDragStart = useCallback((e) => {
    // Don't drag if clicking buttons
    if (e.target.closest('button')) return;
    // Don't drag if clicking on the screen area (for touch input)
    if (e.target.closest('[data-emulator-screen]')) return;
    
    setIsDragging(true);
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      dragOffset.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
    }
    e.preventDefault();
  }, []);

  useEffect(() => {
    const handleDragMove = (e) => {
      if (!isDragging) return;
      const newX = e.clientX - dragOffset.current.x;
      const newY = e.clientY - dragOffset.current.y;
      // Constrain to viewport
      setPosition({
        x: Math.max(0, Math.min(newX, window.innerWidth - 100)),
        y: Math.max(0, Math.min(newY, window.innerHeight - 50)),
      });
    };

    const handleDragEnd = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleDragMove);
      window.addEventListener('mouseup', handleDragEnd);
    }

    return () => {
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('mouseup', handleDragEnd);
    };
  }, [isDragging]);

  // Emit input events for real sessions
  const emitInput = useCallback(
    (payload) => {
      try {
        if (!sessionId) return;
        if (typeof window === 'undefined' || !window.dispatchEvent) return;
        window.dispatchEvent(
          new CustomEvent('synthi:emulator-input', { detail: { sessionId, ...payload } })
        );
      } catch (_) {
        // ignore
      }
    },
    [sessionId]
  );

  // Fake boot completion (UI-only mode)
  useEffect(() => {
    if (sessionId) return;
    if (state !== EMULATOR_STATES.BOOTING) return;
    const id = window.setTimeout(() => {
      setState(EMULATOR_STATES.IDLE);
    }, bootDurationMs);
    return () => window.clearTimeout(id);
  }, [state, bootDurationMs, sessionId]);

  // MediaStream handling
  useEffect(() => {
    if (!sessionId) return;
    if (!mediaStream) {
      setWebrtcDiagnostics('Waiting for mediaStream...');
      return;
    }
    try {
      const vt = typeof mediaStream.getVideoTracks === 'function' ? mediaStream.getVideoTracks() : [];
      const vtInfo = vt.map(t => `${t.id?.slice(0, 6) || '?'}:${t.readyState}:muted=${t.muted}`).join(', ');
      setWebrtcDiagnostics(`stream: ${vt.length} video track(s) [${vtInfo}]`);
      console.debug('[FloatingEmulator] mediaStream received', { videoTracks: vt.length, info: vtInfo, streamId: mediaStream.id });
    } catch (_) {
      setWebrtcDiagnostics('stream received (could not inspect)');
    }
  }, [sessionId, mediaStream]);

  // Attach WebRTC media stream to video element
  useEffect(() => {
    if (!mediaStream) return;
    const el = videoRef.current;
    if (!el) return;
    try {
      if (el.srcObject !== mediaStream) {
        el.srcObject = mediaStream;
      }
      const p = el.play?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {
      // ignore
    }
  }, [mediaStream, state]);

  // Forced error handling
  useEffect(() => {
    if (!forcedErrorMessage) return;
    setErrorMessage(forcedErrorMessage);
    setState(EMULATOR_STATES.ERROR);
  }, [forcedErrorMessage]);

  const buildHelpfulError = useCallback((parsed) => {
    const base = parsed?.message || 'Mobile emulator job failed.';
    const line = parsed?.data?.error || '';
    const combined = [base, line].filter(Boolean).join('\n');

    if (/Android SDK not ready/i.test(combined)) {
      return `${base}\n\nCheck: Android SDK tools/system images are installed in the worker image.`;
    }
    if (/does not contain a Gradle Android build|missing settings\.gradle/i.test(combined)) {
      return `${base}\n\nCheck: your project needs a generated android/ Gradle project (bare RN/Expo prebuild).`;
    }
    if (/Unexpected lock protocol found in lock file|Could not open proj generic class cache|cache .* is corrupt\. Discarding\./i.test(combined)) {
      return `${base}\n\nCheck: the worker's Gradle cache appears corrupted/locked.`;
    }
    if (/EBADENGINE|node:\s*v18\./i.test(combined)) {
      return `${base}\n\nCheck: worker Node version may be too old for your dependencies.`;
    }
    return combined;
  }, []);

  // Listen for worker events
  useEffect(() => {
    if (!sessionId || typeof window === 'undefined') return;

    const handler = (e) => {
      const detail = e?.detail || {};
      if (detail.sessionId !== sessionId) return;
      const line = detail.line;
      if (typeof line !== 'string') return;

      lastEventAtRef.current = Date.now();
      setStreamConnected(true);

      // Capture webrtc diagnostic lines
      if (line.startsWith('[webrtc]')) {
        console.debug('[FloatingEmulator] webrtc diagnostic:', line);
        const statsMatch = line.match(/stats\(video\):\s*bytes=(\d+)\s+packets=(\d+)\s+framesDecoded=(\S+)/);
        if (statsMatch) {
          const [, bytes, packets, frames] = statsMatch;
          setWebrtcDiagnostics(`RTP: ${bytes}B ${packets}pkts ${frames}frames`);
        }
        return;
      }

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

        if (s === 'running' || s === 'streaming' || s === 'ready' || s === 'done') {
          setErrorMessage('');
          setState(EMULATOR_STATES.STREAMING);
          return;
        }

        setErrorMessage('');
        setState(EMULATOR_STATES.BOOTING);
        return;
      }

      if (parsed.type === 'mobile-capabilities') {
        capabilitiesRef.current = parsed?.data || null;
        console.info('[FloatingEmulator] mobile-capabilities received:', parsed?.data);
        return;
      }

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

  // Control handlers
  const handlePower = (e) => {
    e.stopPropagation();
    setErrorMessage('');
    if (sessionId) {
      emitInput({ type: 'key', keycode: 'POWER' });
      return;
    }
    setState((prev) => nextStateOnPower(prev));
  };

  const handleHome = (e) => {
    e.stopPropagation();
    setErrorMessage('');
    if (sessionId) {
      emitInput({ type: 'key', keycode: 'HOME' });
      return;
    }
    setState((prev) => nextStateOnHome(prev));
  };

  const handleRotate = (e) => {
    e.stopPropagation();
    if (sessionId) {
      emitInput({ type: 'rotate' });
    }
    setOrientation((prev) => (prev === 'portrait' ? 'landscape' : 'portrait'));
  };

  const handleClose = (e) => {
    e.stopPropagation();
    if (typeof onClose === 'function') {
      onClose();
    }
  };

  // Scale up/down handlers
  const handleScaleUp = (e) => {
    e.stopPropagation();
    setScale(prev => Math.min(1.5, prev + 0.15));
  };

  const handleScaleDown = (e) => {
    e.stopPropagation();
    setScale(prev => Math.max(0.5, prev - 0.15));
  };

  // Don't render until position is calculated
  if (!position) return null;

  // Frame dimensions (already account for orientation in getDeviceDimensions)
  const frameWidth = deviceWidth;
  const frameHeight = deviceHeight;

  // Container styles
  const containerStyle = {
    position: 'fixed',
    left: position.x,
    top: position.y,
    zIndex: 9999,
    transition: isDragging ? 'none' : 'transform 0.1s ease',
  };

  return (
    <div
      ref={containerRef}
      style={containerStyle}
      className="select-none"
      onMouseDown={handleDragStart}
    >
      {/* Device Frame */}
      <div
        className={`relative ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{
          width: frameWidth + 24, // bezel width
          height: frameHeight + 70, // bezel height (more at bottom for controls)
        }}
      >
        {/* Outer bezel - dark metal frame */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#1a1a1e] to-[#0a0a0c] rounded-[2rem] shadow-2xl border border-[#2a2a2e]">
          
          {/* Inner bezel highlight */}
          <div className="absolute inset-[2px] rounded-[1.9rem] bg-gradient-to-b from-[#252528] to-[#151518] border border-[#333]">
            
            {/* Top speaker/camera area */}
            <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2">
              {/* Camera */}
              <div className="w-2 h-2 rounded-full bg-[#1a1a1e] border border-[#333]">
                <div className="w-1 h-1 rounded-full bg-[#0066ff] opacity-30 m-0.5" />
              </div>
              {/* Speaker */}
              <div className="w-12 h-1.5 rounded-full bg-[#1a1a1e]" />
            </div>

            {/* Close button - top right corner */}
            {typeof onClose === 'function' && (
              <button
                onClick={handleClose}
                className="absolute top-2 right-3 w-5 h-5 rounded-full bg-[#333] hover:bg-red-500/80 flex items-center justify-center transition-colors z-20"
                aria-label="Close emulator"
              >
                <X className="w-3 h-3 text-gray-400 hover:text-white" />
              </button>
            )}

            {/* Screen area */}
            <div 
              data-emulator-screen
              className="absolute left-3 right-3 top-8 bottom-14 rounded-xl bg-black overflow-hidden flex items-center justify-center"
              style={{ cursor: 'default' }}
            >
              <EmulatorScreen
                state={state}
                errorMessage={errorMessage}
                sessionId={sessionId}
                videoRef={videoRef}
                canvasRef={canvasRef}
                mediaStream={mediaStream}
              />
            </div>

            {/* Bottom control area - inside the bezel */}
<div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-2">
              {/* Scale down button */}
              <button
                onClick={handleScaleDown}
                className="w-7 h-7 rounded-full bg-[#1a1a1e] hover:bg-[#2a2a2e] border border-[#333] hover:border-blue-500/50 flex items-center justify-center transition-all group"
                aria-label="Smaller"
                title="Make smaller"
              >
                <Minus className="w-3 h-3 text-gray-500 group-hover:text-blue-400" />
              </button>

              {/* Power button */}
              <button
                onClick={handlePower}
                className="w-8 h-8 rounded-full bg-[#1a1a1e] hover:bg-[#2a2a2e] border border-[#333] hover:border-emerald-500/50 flex items-center justify-center transition-all group"
                aria-label="Power"
              >
                <Power className="w-3.5 h-3.5 text-gray-500 group-hover:text-emerald-400" />
              </button>

              {/* Home button - larger, centered */}
              <button
                onClick={handleHome}
                className="w-10 h-10 rounded-full bg-[#1a1a1e] hover:bg-[#2a2a2e] border-2 border-[#333] hover:border-emerald-500/50 flex items-center justify-center transition-all group"
                aria-label="Home"
              >
                <Home className="w-4 h-4 text-gray-500 group-hover:text-emerald-400" />
              </button>

              {/* Rotate button */}
              <button
                onClick={handleRotate}
                className="w-8 h-8 rounded-full bg-[#1a1a1e] hover:bg-[#2a2a2e] border border-[#333] hover:border-emerald-500/50 flex items-center justify-center transition-all group"
                aria-label="Rotate"
              >
                <RotateCcw className="w-3.5 h-3.5 text-gray-500 group-hover:text-emerald-400" />
              </button>

              {/* Scale up button */}
              <button
                onClick={handleScaleUp}
                className="w-7 h-7 rounded-full bg-[#1a1a1e] hover:bg-[#2a2a2e] border border-[#333] hover:border-blue-500/50 flex items-center justify-center transition-all group"
                aria-label="Larger"
                title="Make larger"
              >
                <Plus className="w-3 h-3 text-gray-500 group-hover:text-blue-400" />
              </button>
            </div>

          </div>
        </div>

        {/* Status indicator - small LED style */}
        <div className={`absolute top-3 left-3 w-1.5 h-1.5 rounded-full ${
          streamConnected ? 'bg-emerald-500 shadow-emerald-500/50 shadow-sm' : 
          state === EMULATOR_STATES.ERROR ? 'bg-red-500 shadow-red-500/50 shadow-sm' :
          state === EMULATOR_STATES.BOOTING ? 'bg-yellow-500 animate-pulse' :
          'bg-gray-600'
        }`} />
      </div>
    </div>
  );
}
