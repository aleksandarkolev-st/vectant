import React, { useState, useRef, useEffect } from 'react';
import { MonitorPlay, X } from 'lucide-react';

export function DraggableVideoWidget({
    guiConfig,
    setGuiConfig,
    isGuiRunning,
    setIsGuiRunning,
    isHmrRecompiling,
    mediaStream,
    sendGuiEvent
}) {
    const [position, setPosition] = useState(null);
    const [isDragging, setIsDragging] = useState(false);
    const dragOffset = useRef({ x: 0, y: 0 });
    const videoRef = useRef(null);
    const containerRef = useRef(null);

    // Initialize position on mount
    useEffect(() => {
        if (typeof window !== 'undefined' && guiConfig && position === null) {
             const initialX = window.innerWidth - (guiConfig.width || 640) - 40;
             const initialY = window.innerHeight - (guiConfig.height || 480) - 40;
             setPosition({ x: Math.max(20, initialX), y: Math.max(20, initialY) });
        }
    }, [guiConfig, position]);

    // Dragging logic
    const handleDragStart = (e) => {
        if (e.target.closest('button')) return; // Don't drag if clicking close button
        setIsDragging(true);
        const rect = containerRef.current.getBoundingClientRect();
        dragOffset.current = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        e.preventDefault(); // Prevent text selection
    };

    useEffect(() => {
        const handleDragMove = (e) => {
            if (!isDragging) return;
            setPosition({
                x: e.clientX - dragOffset.current.x,
                y: e.clientY - dragOffset.current.y
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

    // GUI Interaction Logic
    useEffect(() => {
        const targetEl = videoRef.current;
        if (!targetEl || !guiConfig) return;
        const abortController = typeof AbortController !== 'undefined'
            ? new AbortController()
            : null;
        const listenerOptions = abortController
            ? { signal: abortController.signal }
            : undefined;

        // Calculate coordinates relative to the Xvfb display resolution (guiConfig.width/height)
        // This must account for:
        // 1. The video element's position on screen (getBoundingClientRect)
        // 2. object-contain letterboxing (video may be smaller than container)
        // 3. Scaling from displayed size to actual Xvfb resolution
        const toDisplayCoords = (clientX, clientY) => {
            const rect = targetEl.getBoundingClientRect();
            
            // The target resolution is the Xvfb display size
            const targetWidth = guiConfig.width || 640;
            const targetHeight = guiConfig.height || 480;
            
            // Calculate the actual displayed video size with object-contain
            // object-contain maintains aspect ratio and fits within the container
            const containerWidth = rect.width;
            const containerHeight = rect.height;
            
            const videoAspect = targetWidth / targetHeight;
            const containerAspect = containerWidth / containerHeight;
            
            let renderedWidth, renderedHeight, offsetX, offsetY;
            
            if (containerAspect > videoAspect) {
                // Container is wider than video - letterboxed on sides
                renderedHeight = containerHeight;
                renderedWidth = containerHeight * videoAspect;
                offsetX = (containerWidth - renderedWidth) / 2;
                offsetY = 0;
            } else {
                // Container is taller than video - letterboxed on top/bottom
                renderedWidth = containerWidth;
                renderedHeight = containerWidth / videoAspect;
                offsetX = 0;
                offsetY = (containerHeight - renderedHeight) / 2;
            }
            
            // Convert client coordinates to video-relative coordinates
            const relX = clientX - rect.left - offsetX;
            const relY = clientY - rect.top - offsetY;
            
            // Scale to Xvfb resolution
            const x = Math.round((relX / renderedWidth) * targetWidth);
            const y = Math.round((relY / renderedHeight) * targetHeight);
            
            // Clamp to valid range (in case click is in letterbox area)
            return { 
                x: Math.max(0, Math.min(targetWidth - 1, x)), 
                y: Math.max(0, Math.min(targetHeight - 1, y)) 
            };
        };

        const handleMouseMove = (ev) => {
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'move', x, y });
        };
        const handleMouseDown = (ev) => {
            const button = ev.button === 0 ? 1 : (ev.button === 1 ? 2 : 3);
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'down', x, y, button });
            try { targetEl.focus(); } catch (e) {}
            ev.preventDefault();
        };
        const handleMouseUp = (ev) => {
            const button = ev.button === 0 ? 1 : (ev.button === 1 ? 2 : 3);
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'up', x, y, button });
            ev.preventDefault();
        };
        const handleWheel = (ev) => {
            sendGuiEvent({ type: 'mouse', action: 'wheel', deltaY: ev.deltaY });
            ev.preventDefault();
        };

        const handleKeyDown = (ev) => {
            ev.preventDefault();
            sendGuiEvent({ type: 'key', action: 'down', key: ev.key });
        };
        const handleKeyUp = (ev) => {
            ev.preventDefault();
            sendGuiEvent({ type: 'key', action: 'up', key: ev.key });
        };

        targetEl.addEventListener('mousemove', handleMouseMove, listenerOptions);
        targetEl.addEventListener('mousedown', handleMouseDown, listenerOptions);
        window.addEventListener('mouseup', handleMouseUp, listenerOptions);
        targetEl.addEventListener('wheel', handleWheel, { passive: false, ...(listenerOptions || {}) });
        targetEl.addEventListener('keydown', handleKeyDown, listenerOptions);
        targetEl.addEventListener('keyup', handleKeyUp, listenerOptions);

        return () => {
            abortController?.abort();
            targetEl.removeEventListener('mousemove', handleMouseMove);
            targetEl.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mouseup', handleMouseUp);
            targetEl.removeEventListener('wheel', handleWheel);
            targetEl.removeEventListener('keydown', handleKeyDown);
            targetEl.removeEventListener('keyup', handleKeyUp);
        };
    }, [guiConfig, sendGuiEvent]);

    // Force video refresh on HMR update to ensure new frames are rendered
    useEffect(() => {
        const handleHmrUpdate = () => {
            if (videoRef.current && mediaStream) {
                console.log('Refreshing video stream display for HMR...');
                // Force a re-sync of the video element to ensure it picks up the new stream content
                // This helps if the browser's media engine gets stuck on the last frame
                const video = videoRef.current;
                const currentSrc = video.srcObject;
                
                // Quick toggle to force re-render without significant visual interruption
                // We don't set it to null to avoid a black flash if possible, 
                // but sometimes it's necessary. Let's try just play() first.
                video.play().catch(() => {});
                
                // If that's not enough, we might need to re-assign srcObject
                // video.srcObject = currentSrc; 
            }
        };

        window.addEventListener('synthi:hmr-update', handleHmrUpdate);
        return () => window.removeEventListener('synthi:hmr-update', handleHmrUpdate);
    }, [mediaStream]);

    // When guiConfig or mediaStream changes (e.g. after replace_track on
    // the server), the <video> element may be in a suspended state because it
    // was assigned a placeholder stream with no frames.  Kick it with play().
    useEffect(() => {
        if (!guiConfig || !mediaStream || !videoRef.current) return;
        const el = videoRef.current;
        // Ensure srcObject is set (React ref callback may not re-fire)
        if (el.srcObject !== mediaStream) {
            el.srcObject = mediaStream;
        }
        // Retry play() a few times to handle delayed frame arrival
        let attempts = 0;
        const kick = () => {
            if (!videoRef.current) return;
            videoRef.current.play().catch(() => {});
        };
        kick();
        const timer = setInterval(() => {
            attempts++;
            if (attempts > 10) { clearInterval(timer); return; }
            kick();
        }, 500);
        return () => clearInterval(timer);
    }, [guiConfig, mediaStream]);

    if (!guiConfig) return null;

    // If position is not yet calculated, render hidden or default
    const style = position ? {
        left: position.x,
        top: position.y,
        width: guiConfig.width, 
        height: guiConfig.height,
        maxWidth: '90vw',
        maxHeight: '90vh',
        zIndex: 70,
    } : {
        visibility: 'hidden'
    };

    return (
        <div 
            ref={containerRef}
            className="vt-command-surface fixed flex resize flex-col overflow-hidden rounded-[var(--radius-panel)] border"
            style={{
                ...style,
                background: 'var(--bg-editor)',
                borderColor: isDragging ? 'var(--attention-purple)' : 'var(--border-medium)',
                boxShadow: isDragging
                    ? '0 24px 80px color-mix(in srgb, var(--attention-purple) 18%, transparent)'
                    : '0 24px 80px color-mix(in srgb, var(--bg-app) 72%, transparent)',
            }}
        >
            <div 
                onMouseDown={handleDragStart}
                className="z-10 flex w-full shrink-0 cursor-move select-none items-center gap-2 border-b px-2.5 py-1.5 text-xs"
                style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
            >
                <MonitorPlay className="h-3.5 w-3.5" style={{ color: 'var(--attention-purple)' }} aria-hidden="true" />
                <span className="font-medium" style={{ color: 'var(--text-primary)' }}>GUI output</span>
                <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{guiConfig.width}x{guiConfig.height}</span>
                {isHmrRecompiling && (
                    <span
                        className="vt-state-pill ml-1"
                        style={{
                            color: 'var(--accent-warning)',
                            borderColor: 'color-mix(in srgb, var(--accent-warning) 34%, transparent)',
                            background: 'color-mix(in srgb, var(--accent-warning) 10%, transparent)',
                        }}
                    >
                        Recompiling
                    </span>
                )}
                {!isGuiRunning && !isHmrRecompiling && (
                    <span
                        className="vt-state-pill ml-1"
                        style={{
                            color: 'var(--accent-danger)',
                            borderColor: 'color-mix(in srgb, var(--accent-danger) 34%, transparent)',
                            background: 'color-mix(in srgb, var(--accent-danger) 10%, transparent)',
                        }}
                    >
                        Stopped
                    </span>
                )}
                <button 
                    onClick={(e) => { 
                        e.stopPropagation(); 
                        sendGuiEvent({ type: 'stop-runner' });
                        setGuiConfig(null); 
                        setIsGuiRunning(false); 
                    }} 
                    className="vt-icon-button th-focus-ring ml-auto h-6 min-w-6"
                    title="Close GUI output"
                    aria-label="Close GUI output"
                >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            </div>
            <div className="relative h-full w-full flex-1 overflow-hidden" style={{ background: 'var(--bg-app)' }}>
                {mediaStream ? (
                    <video
                        ref={(el) => {
                            videoRef.current = el;
                            if (el && mediaStream && el.srcObject !== mediaStream) {
                                el.srcObject = mediaStream;
                            }
                        }}
                        tabIndex={0}
                        autoPlay
                        playsInline
                        muted
                        className="block w-full h-full object-contain"
                        onClick={() => { try { videoRef.current && videoRef.current.focus(); } catch (e) {} }}
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center text-xs" style={{ color: 'var(--text-muted)', background: 'var(--bg-app)' }}>
                        {isGuiRunning ? 'Waiting for video stream...' : isHmrRecompiling ? 'Recompiling...' : 'Application exited'}
                    </div>
                )}
            </div>
        </div>
    );
}
